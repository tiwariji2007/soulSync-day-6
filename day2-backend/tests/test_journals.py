from datetime import datetime, timezone

import pytest

from database import SessionLocal
from models import JournalEntry


def _create(client, user_id, title="Day one", content="Dear diary"):
    r = client.post("/journals", json={"user_id": user_id, "title": title, "content": content})
    assert r.status_code == 201, r.text
    return r.json()


# ---------- POST /journals ----------

def test_create_journal(client, user):
    r = client.post(
        "/journals", json={"user_id": user["id"], "title": "Hello", "content": "World"}
    )
    assert r.status_code == 201
    body = r.json()
    assert body["id"] > 0
    assert body["user_id"] == user["id"]
    assert body["title"] == "Hello"
    assert body["content"] == "World"
    assert body["created_at"]
    assert body["updated_at"]


def test_create_journal_unknown_user(client):
    r = client.post("/journals", json={"user_id": 9999, "title": "T", "content": "C"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "user_id"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"title": "T", "content": "C"},
        {"user_id": 1, "content": "C"},
        {"user_id": 1, "title": "T"},
        {"user_id": 1, "title": "", "content": "C"},
        {"user_id": 1, "title": "T", "content": ""},
        {"user_id": 1, "title": "   ", "content": "C"},
        {"user_id": 1, "title": "x" * 201, "content": "C"},
        {"user_id": 1, "title": "T", "content": "x" * 20001},
        {"user_id": "one", "title": "T", "content": "C"},
        {"user_id": 1, "title": ["list"], "content": "C"},
        {"user_id": 1, "title": "T", "content": "C", "mood": "x"},
    ],
)
def test_create_journal_invalid_input(client, user, payload):
    assert client.post("/journals", json=payload).status_code == 422


# ---------- GET /journals ----------

def test_list_journals_pagination(client, user):
    ids = [_create(client, user["id"], title=f"Entry {i}")["id"] for i in range(5)]
    r = client.get("/journals", params={"skip": 2, "limit": 2})
    assert r.status_code == 200
    assert [j["id"] for j in r.json()] == ids[2:4]
    assert len(client.get("/journals", params={"limit": 100}).json()) == 5


def test_list_journals_filter_by_user(client, make_user):
    a, b = make_user(), make_user()
    _create(client, a["id"])
    _create(client, b["id"])
    r = client.get("/journals", params={"user_id": a["id"]})
    assert [j["user_id"] for j in r.json()] == [a["id"]]


@pytest.mark.parametrize("params", [{"skip": -1}, {"limit": 0}, {"limit": 101}])
def test_list_journals_invalid_pagination(client, params):
    assert client.get("/journals", params=params).status_code == 422


# ---------- GET /journals/{id} ----------

def test_get_journal(client, user):
    journal = _create(client, user["id"])
    r = client.get(f"/journals/{journal['id']}")
    assert r.status_code == 200
    assert r.json() == journal


def test_get_journal_not_found(client):
    r = client.get("/journals/9999")
    assert r.status_code == 404
    assert r.json() == {"detail": "Journal entry not found"}


def test_get_journal_invalid_id(client):
    assert client.get("/journals/1.5").status_code == 422


# ---------- PUT /journals/{id} ----------

def test_update_journal_bumps_updated_at(client, user):
    journal = _create(client, user["id"])
    # Review fix: backdate updated_at instead of time.sleep(0.01), which can
    # yield equal timestamps on platforms with a coarse clock.
    with SessionLocal() as db:
        db.get(JournalEntry, journal["id"]).updated_at = datetime(
            2020, 1, 1, tzinfo=timezone.utc
        )
        db.commit()
    journal = client.get(f"/journals/{journal['id']}").json()
    assert journal["updated_at"].startswith("2020-01-01")
    r = client.put(
        f"/journals/{journal['id']}", json={"title": "Edited", "content": "New text"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Edited"
    assert body["content"] == "New text"
    assert body["created_at"] == journal["created_at"]
    assert body["updated_at"] > journal["updated_at"]


def test_update_journal_not_found(client):
    r = client.put("/journals/9999", json={"title": "T", "content": "C"})
    assert r.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [{}, {"title": "T"}, {"content": "C"}, {"title": "", "content": "C"}, {"title": "T", "content": None}],
)
def test_update_journal_invalid_input(client, user, payload):
    journal = _create(client, user["id"])
    assert client.put(f"/journals/{journal['id']}", json=payload).status_code == 422


# ---------- DELETE /journals/{id} ----------

def test_delete_journal(client, user):
    journal = _create(client, user["id"])
    r = client.delete(f"/journals/{journal['id']}")
    assert r.status_code == 204
    assert r.content == b""
    assert client.get(f"/journals/{journal['id']}").status_code == 404


def test_delete_journal_not_found(client):
    assert client.delete("/journals/9999").status_code == 404


def test_timestamps_are_utc_iso8601(client, user):
    journal = _create(client, user["id"])
    for key in ("created_at", "updated_at"):
        assert journal[key].endswith("Z") or journal[key].endswith("+00:00"), journal[key]
    assert user["created_at"].endswith("Z") or user["created_at"].endswith("+00:00")
