import pytest


# ---------- POST /users ----------

def test_create_user(client):
    r = client.post("/users", json={"name": "Asha", "email": "Asha@Example.com"})
    assert r.status_code == 201
    body = r.json()
    assert body["id"] > 0
    assert body["name"] == "Asha"
    assert body["email"] == "asha@example.com"  # normalised to lower case
    assert "created_at" in body


def test_create_user_strips_whitespace(client):
    r = client.post("/users", json={"name": "  Asha  ", "email": "a@example.com"})
    assert r.status_code == 201
    assert r.json()["name"] == "Asha"


def test_create_user_duplicate_email_conflict(client, user):
    r = client.post("/users", json={"name": "Other", "email": user["email"].upper()})
    assert r.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": "No Email"},
        {"email": "noname@example.com"},
        {"name": "Bad", "email": "not-an-email"},
        {"name": "", "email": "a@example.com"},
        {"name": "   ", "email": "a@example.com"},
        {"name": "x" * 101, "email": "a@example.com"},
        {"name": 123, "email": "a@example.com"},
        {"name": "Ok", "email": "a@example.com", "unexpected": "field"},
    ],
)
def test_create_user_invalid_input(client, payload):
    assert client.post("/users", json=payload).status_code == 422


def test_create_user_malformed_json(client):
    r = client.post("/users", content="{bad json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


# ---------- GET /users ----------

def test_list_users_empty(client):
    r = client.get("/users")
    assert r.status_code == 200
    assert r.json() == []


def test_list_users_pagination(client, make_user):
    ids = [make_user()["id"] for _ in range(5)]

    r = client.get("/users", params={"skip": 0, "limit": 2})
    assert r.status_code == 200
    assert [u["id"] for u in r.json()] == ids[:2]

    r = client.get("/users", params={"skip": 2, "limit": 2})
    assert [u["id"] for u in r.json()] == ids[2:4]

    r = client.get("/users", params={"skip": 4, "limit": 10})
    assert [u["id"] for u in r.json()] == ids[4:]

    r = client.get("/users", params={"skip": 10})
    assert r.json() == []


def test_list_users_default_limit_is_20(client, make_user):
    for _ in range(25):
        make_user()
    assert len(client.get("/users").json()) == 20


@pytest.mark.parametrize(
    "params",
    [{"skip": -1}, {"limit": 0}, {"limit": 101}, {"limit": "abc"}, {"skip": "x"}],
)
def test_list_users_invalid_pagination(client, params):
    assert client.get("/users", params=params).status_code == 422


def test_list_users_max_limit_allowed(client):
    assert client.get("/users", params={"limit": 100}).status_code == 200


# ---------- GET /users/{id} ----------

def test_get_user(client, user):
    r = client.get(f"/users/{user['id']}")
    assert r.status_code == 200
    assert r.json() == user


def test_get_user_not_found(client):
    r = client.get("/users/9999")
    assert r.status_code == 404
    assert r.json() == {"detail": "User not found"}


@pytest.mark.parametrize("bad_id", ["abc", "0", "-1"])
def test_get_user_invalid_id(client, bad_id):
    assert client.get(f"/users/{bad_id}").status_code == 422


# ---------- PUT /users/{id} ----------

def test_update_user(client, user):
    r = client.put(f"/users/{user['id']}", json={"name": "New Name", "email": "new@example.com"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "New Name"
    assert body["email"] == "new@example.com"
    assert body["created_at"] == user["created_at"]
    assert client.get(f"/users/{user['id']}").json()["name"] == "New Name"


def test_update_user_keep_same_email(client, user):
    r = client.put(f"/users/{user['id']}", json={"name": "Renamed", "email": user["email"]})
    assert r.status_code == 200


def test_update_user_not_found(client):
    r = client.put("/users/9999", json={"name": "X", "email": "x@example.com"})
    assert r.status_code == 404


def test_update_user_email_conflict(client, make_user):
    a, b = make_user(), make_user()
    r = client.put(f"/users/{a['id']}", json={"name": "A", "email": b["email"]})
    assert r.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "Only name"},
        {"email": "only@example.com"},
        {"name": "X", "email": "bad"},
        {"name": "", "email": "x@example.com"},
    ],
)
def test_update_user_invalid_input(client, user, payload):
    assert client.put(f"/users/{user['id']}", json=payload).status_code == 422


# ---------- DELETE /users/{id} ----------

def test_delete_user(client, user):
    r = client.delete(f"/users/{user['id']}")
    assert r.status_code == 204
    assert r.content == b""
    assert client.get(f"/users/{user['id']}").status_code == 404


def test_delete_user_not_found(client):
    assert client.delete("/users/9999").status_code == 404


def test_delete_user_cascades_to_entries(client, user):
    mood = client.post("/moods", json={"user_id": user["id"], "mood": "happy"}).json()
    journal = client.post(
        "/journals", json={"user_id": user["id"], "title": "T", "content": "C"}
    ).json()

    assert client.delete(f"/users/{user['id']}").status_code == 204
    assert client.get(f"/moods/{mood['id']}").status_code == 404
    assert client.get(f"/journals/{journal['id']}").status_code == 404


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
