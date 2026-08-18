import tempfile
import unittest
from pathlib import Path
from sys import path

from fastapi.testclient import TestClient
from pydantic import ValidationError


path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from auth_middleware import UserIdentity  # noqa: E402
from viewer_api import (  # noqa: E402
    CASE_INDEX,
    CosmosReviewStore,
    ReviewUpdate,
    SqliteReviewStore,
    app,
    get_review_store,
    get_user_identity,
    resolve_volume_path,
)


class FakeCosmosContainer:
    def __init__(self) -> None:
        self.documents: dict[tuple[str, str], dict] = {}

    def upsert_item(self, document: dict) -> dict:
        self.documents[(document["case_id"], document["id"])] = document
        return document

    def query_items(self, *, parameters: list[dict], **_: object) -> list[dict]:
        key = next(
            parameter["value"]
            for parameter in parameters
            if parameter["name"] == "@reviewer_key"
        )
        return [
            document
            for document in self.documents.values()
            if document.get("document_type") == "viewer-review"
            and document.get("reviewer_key") == key
        ]


class ReviewAuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        database = Path(self.temporary_directory.name) / "reviews.db"
        self.store = SqliteReviewStore(str(database))
        self.alice = UserIdentity("tenant", "alice-oid", "Alice")
        self.bob = UserIdentity("tenant", "bob-oid", "Bob")
        self.active_identity = self.alice
        app.dependency_overrides[get_user_identity] = lambda: self.active_identity
        app.dependency_overrides[get_review_store] = lambda: self.store
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        app.dependency_overrides.clear()
        self.temporary_directory.cleanup()

    def test_reviews_are_isolated_by_authenticated_user(self) -> None:
        candidate = CASE_INDEX["case-001"]

        self.store.upsert_review(self.alice, candidate, 5, "Alice note")
        self.store.upsert_review(self.bob, candidate, 2, "Bob note")

        alice_reviews = self.store.list_reviews(self.alice)
        bob_reviews = self.store.list_reviews(self.bob)
        self.assertEqual([(5, "Alice note")], [(r["score"], r["note"]) for r in alice_reviews])
        self.assertEqual([(2, "Bob note")], [(r["score"], r["note"]) for r in bob_reviews])

    def test_cosmos_reviews_are_isolated_by_authenticated_user(self) -> None:
        store = object.__new__(CosmosReviewStore)
        store.container = FakeCosmosContainer()
        candidate = CASE_INDEX["case-001"]

        store.upsert_review(self.alice, candidate, 5, "Alice note")
        store.upsert_review(self.bob, candidate, 2, "Bob note")

        self.assertEqual(5, store.list_reviews(self.alice)[0]["score"])
        self.assertEqual(2, store.list_reviews(self.bob)[0]["score"])

    def test_payload_cannot_select_a_reviewer(self) -> None:
        with self.assertRaises(ValidationError):
            ReviewUpdate.model_validate(
                {"score": 4, "note": "", "reviewer_object_id": "bob-oid"}
            )

    def test_volume_path_cannot_escape_the_data_directory(self) -> None:
        with self.assertRaises(ValueError):
            resolve_volume_path("nifti/../../../Windows/System32/drivers/etc/hosts")

    def test_api_returns_only_the_authenticated_users_review(self) -> None:
        alice_response = self.client.put(
            "/api/reviews/case-001", json={"score": 5, "note": "Alice note"}
        )
        self.assertEqual(200, alice_response.status_code)

        self.active_identity = self.bob
        bob_response = self.client.put(
            "/api/reviews/case-001", json={"score": 2, "note": "Bob note"}
        )
        self.assertEqual(200, bob_response.status_code)
        self.assertEqual(2, self.client.get("/api/reviews").json()["reviews"][0]["score"])

        self.active_identity = self.alice
        alice_reviews = self.client.get("/api/reviews").json()["reviews"]
        self.assertEqual(5, alice_reviews[0]["score"])

        spoof = self.client.put(
            "/api/reviews/case-001",
            json={"score": 1, "note": "", "reviewer_object_id": "bob-oid"},
        )
        self.assertEqual(422, spoof.status_code)


if __name__ == "__main__":
    unittest.main()