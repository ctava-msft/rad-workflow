from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Sequence
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Literal, Protocol
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from auth_middleware import get_current_user


CaseStatus = Literal["candidate", "selected", "in-review", "consensus", "closed"]
CasePriority = Literal["routine", "urgent", "stat"]
ReviewRecommendation = Literal["include", "exclude", "discuss"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CaseCreate(BaseModel):
    accession_number: str = Field(min_length=1, max_length=64)
    patient_reference: str = Field(min_length=1, max_length=128)
    modality: str = Field(min_length=1, max_length=16)
    body_part: str = Field(min_length=1, max_length=80)
    clinical_question: str = Field(min_length=1, max_length=1000)
    priority: CasePriority = "routine"
    selection_reason: str = Field(default="", max_length=1000)


class CaseUpdate(BaseModel):
    status: CaseStatus | None = None
    priority: CasePriority | None = None
    selection_reason: str | None = Field(default=None, max_length=1000)
    assigned_to: list[str] | None = None


class CaseRecord(CaseCreate):
    id: str
    status: CaseStatus
    assigned_to: list[str]
    created_by: str
    created_at: str
    updated_at: str
    review_count: int = 0


class ReviewCreate(BaseModel):
    recommendation: ReviewRecommendation
    comment: str = Field(min_length=1, max_length=4000)


class ReviewRecord(ReviewCreate):
    id: str
    case_id: str
    author: str
    created_at: str


class DashboardSummary(BaseModel):
    total: int
    candidate: int
    selected: int
    in_review: int
    consensus: int
    urgent: int


class CaseStore(Protocol):
    def list_cases(self) -> list[dict[str, Any]]: ...

    def get_case(self, case_id: str) -> dict[str, Any] | None: ...

    def create_case(self, case: dict[str, Any]) -> dict[str, Any]: ...

    def replace_case(self, case: dict[str, Any]) -> dict[str, Any]: ...

    def list_reviews(self, case_id: str) -> list[dict[str, Any]]: ...

    def create_review(self, review: dict[str, Any]) -> dict[str, Any]: ...


class SqliteCaseStore:
    def __init__(self, path: str) -> None:
        self.path = path
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY,
                    document TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    document TEXT NOT NULL,
                    FOREIGN KEY(case_id) REFERENCES cases(id)
                );
                CREATE INDEX IF NOT EXISTS reviews_case_id_idx ON reviews(case_id);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def list_cases(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT document FROM cases").fetchall()
        return [json.loads(row["document"]) for row in rows]

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT document FROM cases WHERE id = ?", (case_id,)
            ).fetchone()
        return json.loads(row["document"]) if row else None

    def create_case(self, case: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO cases (id, document) VALUES (?, ?)",
                (case["id"], json.dumps(case)),
            )
        return case

    def replace_case(self, case: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE cases SET document = ? WHERE id = ?",
                (json.dumps(case), case["id"]),
            )
        if cursor.rowcount == 0:
            raise KeyError(case["id"])
        return case

    def list_reviews(self, case_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT document FROM reviews WHERE case_id = ?", (case_id,)
            ).fetchall()
        return [json.loads(row["document"]) for row in rows]

    def create_review(self, review: dict[str, Any]) -> dict[str, Any]:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO reviews (id, case_id, document) VALUES (?, ?, ?)",
                (review["id"], review["case_id"], json.dumps(review)),
            )
        return review


class CosmosCaseStore:
    def __init__(self) -> None:
        from azure.cosmos import CosmosClient
        from azure.identity import DefaultAzureCredential

        endpoint = os.environ["COSMOS_ENDPOINT"]
        database_name = os.getenv("COSMOS_DATABASE", "radiology")
        container_name = os.getenv("COSMOS_CONTAINER", "cases")
        key = os.getenv("COSMOS_KEY")
        credential: str | DefaultAzureCredential
        if key:
            credential = key
        else:
            credential = DefaultAzureCredential(
                managed_identity_client_id=os.getenv("AZURE_CLIENT_ID") or None
            )
        client = CosmosClient(endpoint, credential=credential)
        self.container = client.get_database_client(database_name).get_container_client(
            container_name
        )

    @staticmethod
    def _clean(document: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in document.items() if not key.startswith("_")}

    def list_cases(self) -> list[dict[str, Any]]:
        documents = self.container.query_items(
            "SELECT * FROM c WHERE c.document_type = 'case'",
            enable_cross_partition_query=True,
        )
        return [self._clean(document) for document in documents]

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        try:
            document = self.container.read_item(item=case_id, partition_key=case_id)
        except Exception as error:
            if getattr(error, "status_code", None) == 404:
                return None
            raise
        return self._clean(document)

    def create_case(self, case: dict[str, Any]) -> dict[str, Any]:
        document = {**case, "case_id": case["id"], "document_type": "case"}
        return self._clean(self.container.create_item(document))

    def replace_case(self, case: dict[str, Any]) -> dict[str, Any]:
        document = {**case, "case_id": case["id"], "document_type": "case"}
        return self._clean(self.container.replace_item(item=case["id"], body=document))

    def list_reviews(self, case_id: str) -> list[dict[str, Any]]:
        documents = self.container.query_items(
            "SELECT * FROM c WHERE c.document_type = 'review'",
            partition_key=case_id,
        )
        return [self._clean(document) for document in documents]

    def create_review(self, review: dict[str, Any]) -> dict[str, Any]:
        document = {**review, "document_type": "review"}
        return self._clean(self.container.create_item(document))


@lru_cache(maxsize=1)
def get_case_store() -> CaseStore:
    if os.getenv("CASE_STORE", "sqlite").lower() == "cosmos":
        return CosmosCaseStore()
    return SqliteCaseStore(os.getenv("SQLITE_PATH", "/data/radiology.db"))


def user_display_name(user: dict[str, Any]) -> str:
    for claim in ("name", "preferred_username", "email", "upn", "oid", "sub"):
        value = user.get(claim)
        if value:
            return str(value)
    return "Unknown clinician"


app = FastAPI(
    title="Radiology Case Collaboration API",
    version="1.0.0",
    docs_url="/docs" if os.getenv("ENABLE_API_DOCS", "false").lower() == "true" else None,
    redoc_url=None,
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/healthz", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/api/me", tags=["identity"])
def me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, str]:
    return {"display_name": user_display_name(user)}


@app.get("/api/cases", response_model=list[CaseRecord], tags=["cases"])
def list_cases(
    case_status: CaseStatus | None = Query(default=None, alias="status"),
    modality: str | None = None,
    store: CaseStore = Depends(get_case_store),
    _: dict[str, Any] = Depends(get_current_user),
) -> Sequence[dict[str, Any]]:
    cases = store.list_cases()
    if case_status:
        cases = [case for case in cases if case["status"] == case_status]
    if modality:
        cases = [
            case for case in cases if case["modality"].lower() == modality.lower()
        ]
    return sorted(cases, key=lambda case: case["updated_at"], reverse=True)


@app.post(
    "/api/cases",
    response_model=CaseRecord,
    status_code=status.HTTP_201_CREATED,
    tags=["cases"],
)
def create_case(
    payload: CaseCreate,
    store: CaseStore = Depends(get_case_store),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    timestamp = utc_now()
    case = {
        **payload.model_dump(),
        "id": str(uuid4()),
        "status": "candidate",
        "assigned_to": [],
        "created_by": user_display_name(user),
        "created_at": timestamp,
        "updated_at": timestamp,
        "review_count": 0,
    }
    return store.create_case(case)


def require_case(case_id: str, store: CaseStore) -> dict[str, Any]:
    case = store.get_case(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


@app.get("/api/cases/{case_id}", response_model=CaseRecord, tags=["cases"])
def get_case(
    case_id: str,
    store: CaseStore = Depends(get_case_store),
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return require_case(case_id, store)


@app.patch("/api/cases/{case_id}", response_model=CaseRecord, tags=["cases"])
def update_case(
    case_id: str,
    payload: CaseUpdate,
    store: CaseStore = Depends(get_case_store),
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    case = require_case(case_id, store)
    changes = payload.model_dump(exclude_none=True)
    case.update(changes)
    case["updated_at"] = utc_now()
    return store.replace_case(case)


@app.get(
    "/api/cases/{case_id}/reviews",
    response_model=list[ReviewRecord],
    tags=["reviews"],
)
def list_reviews(
    case_id: str,
    store: CaseStore = Depends(get_case_store),
    _: dict[str, Any] = Depends(get_current_user),
) -> Sequence[dict[str, Any]]:
    require_case(case_id, store)
    return sorted(
        store.list_reviews(case_id), key=lambda review: review["created_at"]
    )


@app.post(
    "/api/cases/{case_id}/reviews",
    response_model=ReviewRecord,
    status_code=status.HTTP_201_CREATED,
    tags=["reviews"],
)
def create_review(
    case_id: str,
    payload: ReviewCreate,
    store: CaseStore = Depends(get_case_store),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    case = require_case(case_id, store)
    timestamp = utc_now()
    review = {
        **payload.model_dump(),
        "id": str(uuid4()),
        "case_id": case_id,
        "author": user_display_name(user),
        "created_at": timestamp,
    }
    created = store.create_review(review)
    case["review_count"] = int(case.get("review_count", 0)) + 1
    case["updated_at"] = timestamp
    store.replace_case(case)
    return created


@app.get("/api/dashboard", response_model=DashboardSummary, tags=["cases"])
def dashboard(
    store: CaseStore = Depends(get_case_store),
    _: dict[str, Any] = Depends(get_current_user),
) -> DashboardSummary:
    cases = store.list_cases()
    return DashboardSummary(
        total=len(cases),
        candidate=sum(case["status"] == "candidate" for case in cases),
        selected=sum(case["status"] == "selected" for case in cases),
        in_review=sum(case["status"] == "in-review" for case in cases),
        consensus=sum(case["status"] == "consensus" for case in cases),
        urgent=sum(case["priority"] in ("urgent", "stat") for case in cases),
    )