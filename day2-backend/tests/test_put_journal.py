"""Focused test suite for one endpoint: PUT /journals/{journal_id}.

Contract under test (routes/journals.py, schemas.JournalUpdate):
  * 200 + full JournalRead body when the entry exists and the body is valid
  * the update replaces title and content and is persisted
  * user_id and created_at never change; updated_at moves forward
  * 404 {"detail": "Journal entry not found"} for a missing entry
  * 422 for an invalid path id or an invalid body (missing/blank/too long/
    wrong type/unknown fields such as user_id)
  * a failed request leaves the stored entry untouched

Each test gets a fresh in-memory SQLite database (autouse `fresh_db` fixture
in conftest.py), so tests are independent and order does not matter.
"""

from datetime import datetime, timedelta, timezone

import pytest

from database import SessionLocal
from models import JournalEntry

ORIGINAL = {"title": "Original title", "content": "Original content"}
UPDATE = {"title": "Updated title", "content": "Updated content"}


@pytest.fixture
def journal(client, user):
    r = client.post("/journals", json={"user_id": user["id"], **ORIGINAL})
    assert r.status_code == 201, r.text
    return r.json()


def put(client, journal_id, payload):
    return client.put(f"/journals/{journal_id}", json=payload)


def stored(journal_id):
    """Reads the row straight from the database, bypassing the API."""
    with SessionLocal() as db:
        return db.get(JournalEntry, journal_id)


def backdate(journal_id, when):
    """Moves updated_at into the past so 'it moved forward' is deterministic."""
    with SessionLocal() as db:
        row = db.get(JournalEntry, journal_id)
        row.updated_at = when
        db.commit()


# ---------- success ----------

def test_update_returns_full_updated_record(client, journal, user):
    r = put(client, journal["id"], UPDATE)

    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"id", "user_id", "title", "content", "created_at", "updated_at"}
    assert body["id"] == journal["id"]
    assert body["user_id"] == user["id"]
    assert body["title"] == UPDATE["title"]
    assert body["content"] == UPDATE["content"]
    assert body["created_at"] == journal["created_at"]
    # Review fix: updated_at used to be compared with itself (always true).
    updated_at = datetime.fromisoformat(body["updated_at"])
    assert updated_at.tzinfo is not None
    assert updated_at >= datetime.fromisoformat(body["created_at"])


def test_update_is_persisted(client, journal):
    put(client, journal["id"], UPDATE)

    row = stored(journal["id"])
    assert (row.title, row.content) == (UPDATE["title"], UPDATE["content"])
    assert client.get(f"/journals/{journal['id']}").json()["title"] == UPDATE["title"]


def test_update_moves_updated_at_forward_and_keeps_created_at(client, journal):
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    backdate(journal["id"], past)
    # Review fix: prove the precondition, otherwise the assertion below would
    # pass even if the endpoint never touched updated_at.
    before = client.get(f"/journals/{journal['id']}").json()
    assert datetime.fromisoformat(before["updated_at"]) == past

    body = put(client, journal["id"], UPDATE).json()

    updated_at = datetime.fromisoformat(body["updated_at"])
    assert updated_at > past + timedelta(days=1)
    assert body["created_at"] == journal["created_at"]


def test_update_strips_surrounding_whitespace(client, journal):
    r = put(client, journal["id"], {"title": "  Spaced  ", "content": "\n Body \t"})

    assert r.status_code == 200
    assert (r.json()["title"], r.json()["content"]) == ("Spaced", "Body")


def test_update_with_identical_values_succeeds(client, journal):
    r = put(client, journal["id"], ORIGINAL)

    assert r.status_code == 200
    assert r.json()["title"] == ORIGINAL["title"]


@pytest.mark.parametrize(
    "field,length", [("title", 1), ("title", 200), ("content", 1), ("content", 20_000)]
)
def test_update_accepts_length_boundaries(client, journal, field, length):
    payload = {**UPDATE, field: "x" * length}

    r = put(client, journal["id"], payload)

    assert r.status_code == 200
    assert len(r.json()[field]) == length


def test_update_accepts_unicode(client, journal):
    payload = {"title": "Día bueno 🌞", "content": "धन्यवाद — merci"}

    r = put(client, journal["id"], payload)

    assert r.status_code == 200
    assert r.json()["title"] == payload["title"]
    assert stored(journal["id"]).content == payload["content"]


def test_update_only_touches_the_target_entry(client, journal, user, make_user):
    other_user = make_user()
    sibling = client.post("/journals", json={"user_id": user["id"], **ORIGINAL}).json()
    foreign = client.post("/journals", json={"user_id": other_user["id"], **ORIGINAL}).json()

    put(client, journal["id"], UPDATE)

    assert client.get(f"/journals/{sibling['id']}").json() == sibling
    assert client.get(f"/journals/{foreign['id']}").json() == foreign


# ---------- missing records ----------

def test_update_missing_entry_returns_404(client):
    r = put(client, 9999, UPDATE)

    assert r.status_code == 404
    assert r.json() == {"detail": "Journal entry not found"}


def test_update_deleted_entry_returns_404(client, journal):
    assert client.delete(f"/journals/{journal['id']}").status_code == 204

    r = put(client, journal["id"], UPDATE)

    assert r.status_code == 404
    assert stored(journal["id"]) is None


def test_update_missing_entry_does_not_create_one(client):
    assert put(client, 1, UPDATE).status_code == 404

    assert client.get("/journals").json() == []


# ---------- invalid input ----------

@pytest.mark.parametrize("journal_id", ["0", "-1", "abc", "1.5"])
def test_update_rejects_invalid_path_id(client, journal_id):
    r = client.put(f"/journals/{journal_id}", json=UPDATE)

    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["path", "journal_id"]


@pytest.mark.parametrize(
    "payload,bad_field",
    [
        ({"content": "C"}, "title"),
        ({"title": "T"}, "content"),
        ({"title": "", "content": "C"}, "title"),
        ({"title": "   ", "content": "C"}, "title"),
        ({"title": "T", "content": " \n "}, "content"),
        ({"title": "x" * 201, "content": "C"}, "title"),
        ({"title": "T", "content": "x" * 20_001}, "content"),
        ({"title": None, "content": "C"}, "title"),
        ({"title": 123, "content": "C"}, "title"),
        ({"title": "T", "content": ["a"]}, "content"),
        ({"title": "T", "content": "C", "user_id": 2}, "user_id"),
        ({"title": "T", "content": "C", "id": 5}, "id"),
    ],
)
def test_update_rejects_invalid_body(client, journal, payload, bad_field):
    r = put(client, journal["id"], payload)

    assert r.status_code == 422
    assert ["body", bad_field] in [error["loc"] for error in r.json()["detail"]]
    # A rejected request must not change the stored entry.
    row = stored(journal["id"])
    assert (row.title, row.content) == (ORIGINAL["title"], ORIGINAL["content"])


@pytest.mark.parametrize("raw", ["", "not json", "[]", '"a string"', "null"])
def test_update_rejects_non_object_bodies(client, journal, raw):
    r = client.put(
        f"/journals/{journal['id']}",
        content=raw,
        headers={"Content-Type": "application/json"},
    )

    assert r.status_code == 422
    assert stored(journal["id"]).title == ORIGINAL["title"]


def test_invalid_body_on_missing_entry_is_422_not_404(client):
    """Body validation runs before the database lookup."""
    assert put(client, 9999, {"title": ""}).status_code == 422


# ---------- edge cases ----------

def test_update_cannot_move_entry_to_another_user(client, journal, user, make_user):
    other = make_user()

    r = put(client, journal["id"], {**UPDATE, "user_id": other["id"]})

    assert r.status_code == 422
    assert stored(journal["id"]).user_id == user["id"]


def test_repeated_identical_updates_are_idempotent(client, journal):
    first = put(client, journal["id"], UPDATE).json()
    second = put(client, journal["id"], UPDATE).json()

    for key in ("id", "user_id", "title", "content", "created_at"):
        assert first[key] == second[key]


def test_update_accepts_largest_valid_id(client):
    """2**31 - 1 is the INTEGER maximum: valid id, so a missing row is 404."""
    assert put(client, 2**31 - 1, UPDATE).status_code == 404


@pytest.mark.parametrize("journal_id", [2**31, 2**63, 10**30])
def test_update_with_out_of_range_id_is_422_not_500(client, journal_id):
    """Regression: 2**63 used to raise OverflowError in SQLite (HTTP 500)."""
    r = client.put(f"/journals/{journal_id}", json=UPDATE)

    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["path", "journal_id"]
