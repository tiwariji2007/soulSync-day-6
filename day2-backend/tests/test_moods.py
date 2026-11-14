import pytest


def _create(client, user_id, mood="happy", note=None):
    payload = {"user_id": user_id, "mood": mood}
    if note is not None:
        payload["note"] = note
    r = client.post("/moods", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


# ---------- POST /moods ----------

def test_create_mood(client, user):
    r = client.post("/moods", json={"user_id": user["id"], "mood": "calm", "note": "Good day"})
    assert r.status_code == 201
    body = r.json()
    assert body["id"] > 0
    assert body["user_id"] == user["id"]
    assert body["mood"] == "calm"
    assert body["note"] == "Good day"
    assert "created_at" in body


def test_create_mood_note_optional(client, user):
    r = client.post("/moods", json={"user_id": user["id"], "mood": "tired"})
    assert r.status_code == 201
    assert r.json()["note"] is None


def test_create_mood_unknown_user(client):
    r = client.post("/moods", json={"user_id": 9999, "mood": "happy"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "user_id"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"mood": "happy"},
        {"user_id": 1},
        {"user_id": 1, "mood": ""},
        {"user_id": 1, "mood": "   "},
        {"user_id": 1, "mood": "x" * 51},
        {"user_id": 1, "mood": "happy", "note": "x" * 1001},
        {"user_id": "1", "mood": "happy"},
        {"user_id": "abc", "mood": "happy"},
        {"user_id": 0, "mood": "happy"},
        {"user_id": -5, "mood": "happy"},
        {"user_id": 1, "mood": 42},
        {"user_id": 1, "mood": "happy", "extra": True},
    ],
)
def test_create_mood_invalid_input(client, user, payload):
    assert client.post("/moods", json=payload).status_code == 422


# ---------- GET /moods ----------

def test_list_moods_pagination(client, user):
    ids = [_create(client, user["id"])["id"] for _ in range(5)]
    r = client.get("/moods", params={"skip": 1, "limit": 3})
    assert r.status_code == 200
    assert [m["id"] for m in r.json()] == ids[1:4]
    assert client.get("/moods", params={"skip": 5}).json() == []


def test_list_moods_filter_by_user(client, make_user):
    a, b = make_user(), make_user()
    _create(client, a["id"])
    _create(client, b["id"])
    _create(client, b["id"])
    r = client.get("/moods", params={"user_id": b["id"]})
    assert r.status_code == 200
    assert len(r.json()) == 2
    assert all(m["user_id"] == b["id"] for m in r.json())


@pytest.mark.parametrize("params", [{"skip": -1}, {"limit": 0}, {"limit": 101}, {"user_id": 0}])
def test_list_moods_invalid_query(client, params):
    assert client.get("/moods", params=params).status_code == 422


# ---------- GET /moods/{id} ----------

def test_get_mood(client, user):
    mood = _create(client, user["id"], note="hi")
    r = client.get(f"/moods/{mood['id']}")
    assert r.status_code == 200
    assert r.json() == mood


def test_get_mood_not_found(client):
    r = client.get("/moods/9999")
    assert r.status_code == 404
    assert r.json() == {"detail": "Mood entry not found"}


def test_get_mood_invalid_id(client):
    assert client.get("/moods/abc").status_code == 422


# ---------- PUT /moods/{id} ----------

def test_update_mood(client, user):
    mood = _create(client, user["id"], note="before")
    r = client.put(f"/moods/{mood['id']}", json={"mood": "excited", "note": "after"})
    assert r.status_code == 200
    body = r.json()
    assert body["mood"] == "excited"
    assert body["note"] == "after"
    assert body["user_id"] == user["id"]
    assert client.get(f"/moods/{mood['id']}").json()["mood"] == "excited"


def test_update_mood_clears_note_when_omitted(client, user):
    mood = _create(client, user["id"], note="before")
    r = client.put(f"/moods/{mood['id']}", json={"mood": "sad"})
    assert r.status_code == 200
    assert r.json()["note"] is None


def test_update_mood_not_found(client):
    assert client.put("/moods/9999", json={"mood": "sad"}).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [{}, {"mood": ""}, {"mood": None}, {"note": "only note"}, {"mood": "ok", "user_id": 2}],
)
def test_update_mood_invalid_input(client, user, payload):
    mood = _create(client, user["id"])
    assert client.put(f"/moods/{mood['id']}", json=payload).status_code == 422


# ---------- DELETE /moods/{id} ----------

def test_delete_mood(client, user):
    mood = _create(client, user["id"])
    r = client.delete(f"/moods/{mood['id']}")
    assert r.status_code == 204
    assert r.content == b""
    assert client.get(f"/moods/{mood['id']}").status_code == 404
    # The owning user is untouched.
    assert client.get(f"/users/{user['id']}").status_code == 200


def test_delete_mood_not_found(client):
    assert client.delete("/moods/9999").status_code == 404
