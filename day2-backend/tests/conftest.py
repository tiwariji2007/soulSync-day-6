"""Test fixtures.

Tests always run against an in-memory SQLite database. DATABASE_URL is
forcibly overridden *before* the app is imported, so a PostgreSQL URL in
the environment or in .env can never be touched by the test suite.
"""

import os

os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from database import Base, engine  # noqa: E402
from main import app  # noqa: E402

assert engine.dialect.name == "sqlite", "Refusing to run tests against a non-SQLite database"


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def make_user(client):
    counter = {"n": 0}

    def _make(name: str = "Test User", email: str | None = None) -> dict:
        counter["n"] += 1
        email = email or f"user{counter['n']}@example.com"
        r = client.post("/users", json={"name": name, "email": email})
        assert r.status_code == 201, r.text
        return r.json()

    return _make


@pytest.fixture
def user(make_user):
    return make_user()
