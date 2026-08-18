from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from auth_middleware import (
    UserIdentity,
    get_current_user,
    identity_from_claims,
)


module_data_dir = Path(__file__).resolve().parent / "data"
checkout_data_dir = Path(__file__).resolve().parents[1] / "data"
default_data_dir = module_data_dir if module_data_dir.is_dir() else checkout_data_dir
DATA_DIR = Path(os.getenv("VIEWER_DATA_DIR", default_data_dir))
MANIFEST_PATH = DATA_DIR / "manifest.json"
SORT_MODES = {"case", "score-desc", "score-asc", "unscored-first"}
SortMode = Literal["case", "score-desc", "score-asc", "unscored-first"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.is_file():
        raise RuntimeError(f"Viewer manifest not found: {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


MANIFEST = load_manifest()
CASE_INDEX = {candidate["id"]: candidate for candidate in MANIFEST.get("cases", [])}


class ReviewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: int | None = Field(default=None, ge=1, le=5)
    note: str = Field(default="", max_length=4000)

    @field_validator("score", mode="before")
    @classmethod
    def validate_score(cls, value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("score must be a number between 1 and 5, or null")
        if isinstance(value, float) and not value.is_integer():
            raise ValueError("score must be a whole number")
        return int(value)

    @field_validator("note")
    @classmethod
    def normalize_note(cls, value: str) -> str:
        return value.strip()


class PreferenceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sort: SortMode


def reviewer_key(identity: UserIdentity) -> str:
    return hashlib.sha256(identity.key.encode("utf-8")).hexdigest()


def resolve_volume_path(source_blob: str) -> Path:
    blob_path = PurePosixPath(source_blob)
    if not blob_path.parts or blob_path.parts[0] != "nifti":
        raise ValueError("Invalid volume path in manifest")
    volume_root = (DATA_DIR / "volumes").resolve()
    volume_path = (volume_root / Path(*blob_path.parts[1:])).resolve()
    try:
        volume_path.relative_to(volume_root)
    except ValueError as error:
        raise ValueError("Invalid volume path in manifest") from error
    return volume_path


def public_review(document: dict[str, Any]) -> dict[str, Any]:
    return {
        key: document.get(key)
        for key in (
            "case_id",
            "case_number",
            "patient_id",
            "score",
            "note",
            "updated_at",
        )
    }


class ReviewStore(Protocol):
    def list_reviews(self, identity: UserIdentity) -> list[dict[str, Any]]: ...

    def upsert_review(
        self,
        identity: UserIdentity,
        candidate: dict[str, Any],
        score: int | None,
        note: str,
    ) -> dict[str, Any]: ...

    def get_sort(self, identity: UserIdentity) -> SortMode: ...

    def update_sort(self, identity: UserIdentity, sort: SortMode) -> SortMode: ...


class SqliteReviewStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS reviews (
                    reviewer_key TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    case_number INTEGER NOT NULL,
                    patient_id TEXT NOT NULL,
                    score INTEGER,
                    note TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (reviewer_key, case_id)
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    reviewer_key TEXT PRIMARY KEY,
                    sort TEXT NOT NULL
                );
                """
            )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def list_reviews(self, identity: UserIdentity) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT case_id, case_number, patient_id, score, note, updated_at
                FROM reviews
                WHERE reviewer_key = ?
                ORDER BY case_number
                """,
                (reviewer_key(identity),),
            ).fetchall()
        return [dict(row) for row in rows]

    def upsert_review(
        self,
        identity: UserIdentity,
        candidate: dict[str, Any],
        score: int | None,
        note: str,
    ) -> dict[str, Any]:
        key = reviewer_key(identity)
        case_id = candidate["id"]
        if score is None and not note:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM reviews WHERE reviewer_key = ? AND case_id = ?",
                    (key, case_id),
                )
            return {"case_id": case_id, "score": None, "note": ""}

        updated_at = utc_now()
        record = {
            "case_id": case_id,
            "case_number": candidate["case_number"],
            "patient_id": candidate["patient_id"],
            "score": score,
            "note": note,
            "updated_at": updated_at,
        }
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO reviews (
                    reviewer_key, case_id, case_number, patient_id,
                    score, note, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(reviewer_key, case_id) DO UPDATE SET
                    case_number = excluded.case_number,
                    patient_id = excluded.patient_id,
                    score = excluded.score,
                    note = excluded.note,
                    updated_at = excluded.updated_at
                """,
                (
                    key,
                    record["case_id"],
                    record["case_number"],
                    record["patient_id"],
                    record["score"],
                    record["note"],
                    record["updated_at"],
                ),
            )
        return record

    def get_sort(self, identity: UserIdentity) -> SortMode:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT sort FROM preferences WHERE reviewer_key = ?",
                (reviewer_key(identity),),
            ).fetchone()
        value = row["sort"] if row else "case"
        return value if value in SORT_MODES else "case"  # type: ignore[return-value]

    def update_sort(self, identity: UserIdentity, sort: SortMode) -> SortMode:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO preferences (reviewer_key, sort) VALUES (?, ?)
                ON CONFLICT(reviewer_key) DO UPDATE SET sort = excluded.sort
                """,
                (reviewer_key(identity), sort),
            )
        return sort


class CosmosReviewStore:
    def __init__(self) -> None:
        from azure.cosmos import CosmosClient
        from azure.identity import DefaultAzureCredential

        credential = os.getenv("COSMOS_KEY") or DefaultAzureCredential(
            managed_identity_client_id=os.getenv("AZURE_CLIENT_ID") or None
        )
        client = CosmosClient(os.environ["COSMOS_ENDPOINT"], credential=credential)
        database = client.get_database_client(
            os.getenv("COSMOS_DATABASE", "radiology")
        )
        self.container = database.get_container_client(
            os.getenv("COSMOS_CONTAINER", "cases")
        )

    def list_reviews(self, identity: UserIdentity) -> list[dict[str, Any]]:
        documents = self.container.query_items(
            query=(
                "SELECT * FROM c WHERE c.document_type = 'viewer-review' "
                "AND c.reviewer_key = @reviewer_key"
            ),
            parameters=[
                {"name": "@reviewer_key", "value": reviewer_key(identity)}
            ],
            enable_cross_partition_query=True,
        )
        reviews = [public_review(document) for document in documents]
        return sorted(reviews, key=lambda review: review.get("case_number") or 0)

    def upsert_review(
        self,
        identity: UserIdentity,
        candidate: dict[str, Any],
        score: int | None,
        note: str,
    ) -> dict[str, Any]:
        key = reviewer_key(identity)
        case_id = candidate["id"]
        item_id = f"viewer-review:{key}"
        if score is None and not note:
            from azure.cosmos.exceptions import CosmosResourceNotFoundError

            try:
                self.container.delete_item(item=item_id, partition_key=case_id)
            except CosmosResourceNotFoundError:
                pass
            return {"case_id": case_id, "score": None, "note": ""}

        document = {
            "id": item_id,
            "case_id": case_id,
            "document_type": "viewer-review",
            "reviewer_key": key,
            "reviewer_tenant_id": identity.tenant_id,
            "reviewer_object_id": identity.object_id,
            "reviewer_display_name": identity.display_name,
            "case_number": candidate["case_number"],
            "patient_id": candidate["patient_id"],
            "score": score,
            "note": note,
            "updated_at": utc_now(),
        }
        return public_review(self.container.upsert_item(document))

    def get_sort(self, identity: UserIdentity) -> SortMode:
        from azure.cosmos.exceptions import CosmosResourceNotFoundError

        key = reviewer_key(identity)
        partition = f"viewer-preferences:{key}"
        try:
            document = self.container.read_item(
                item="viewer-preferences", partition_key=partition
            )
        except CosmosResourceNotFoundError:
            return "case"
        value = document.get("sort", "case")
        return value if value in SORT_MODES else "case"  # type: ignore[return-value]

    def update_sort(self, identity: UserIdentity, sort: SortMode) -> SortMode:
        key = reviewer_key(identity)
        partition = f"viewer-preferences:{key}"
        self.container.upsert_item(
            {
                "id": "viewer-preferences",
                "case_id": partition,
                "document_type": "viewer-preferences",
                "reviewer_key": key,
                "sort": sort,
                "updated_at": utc_now(),
            }
        )
        return sort


@lru_cache(maxsize=1)
def get_review_store() -> ReviewStore:
    if os.getenv("CASE_STORE", "sqlite").lower() == "cosmos":
        return CosmosReviewStore()
    return SqliteReviewStore(os.getenv("SQLITE_PATH", "/data/reviews.db"))


async def get_user_identity(
    claims: dict[str, Any] = Depends(get_current_user),
) -> UserIdentity:
    return identity_from_claims(claims)


app = FastAPI(
    title="SegMed ICH Progression Review API",
    version="2.0.0",
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
    allow_credentials=False,
    allow_methods=["GET", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/healthz", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/api/me", tags=["identity"])
def me(identity: UserIdentity = Depends(get_user_identity)) -> dict[str, str]:
    return {"display_name": identity.display_name}


@app.get("/api/manifest", tags=["viewer"])
def manifest(_: UserIdentity = Depends(get_user_identity)) -> dict[str, Any]:
    return MANIFEST


@app.get("/api/volumes/{case_id}/{phase}", tags=["viewer"])
def volume(
    case_id: str,
    phase: Literal["prior", "later"],
    _: UserIdentity = Depends(get_user_identity),
) -> FileResponse:
    candidate = CASE_INDEX.get(case_id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Unknown case id")
    try:
        volume_path = resolve_volume_path(candidate[phase]["volume"]["source_blob"])
    except ValueError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    if not volume_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Imaging volume is not prepared on this deployment.",
        )
    return FileResponse(
        volume_path,
        media_type="application/gzip",
        filename=volume_path.name,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.get("/api/reviews", tags=["reviews"])
def list_reviews(
    identity: UserIdentity = Depends(get_user_identity),
    store: ReviewStore = Depends(get_review_store),
) -> dict[str, Any]:
    return {
        "version": 3,
        "reviewer": {"display_name": identity.display_name},
        "preferences": {"sort": store.get_sort(identity)},
        "reviews": store.list_reviews(identity),
    }


@app.put("/api/reviews/{case_id}", tags=["reviews"])
def put_review(
    case_id: str,
    payload: ReviewUpdate,
    identity: UserIdentity = Depends(get_user_identity),
    store: ReviewStore = Depends(get_review_store),
) -> dict[str, Any]:
    candidate = CASE_INDEX.get(case_id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Unknown case id")
    review = store.upsert_review(
        identity, candidate, payload.score, payload.note
    )
    return {"review": review}


@app.put("/api/preferences", tags=["reviews"])
def put_preferences(
    payload: PreferenceUpdate,
    identity: UserIdentity = Depends(get_user_identity),
    store: ReviewStore = Depends(get_review_store),
) -> dict[str, Any]:
    return {"preferences": {"sort": store.update_sort(identity, payload.sort)}}