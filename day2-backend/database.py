"""Database engine and session management.

The connection string is read from the DATABASE_URL environment variable
(optionally loaded from backend/.env). No credentials live in source code.
"""

import os
from collections.abc import Generator
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

# Load only this backend's .env file, never a parent project's .env.
# Existing environment variables take precedence over the file.
load_dotenv(Path(__file__).resolve().parent / ".env")

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Copy .env.example to .env and fill in "
        "your PostgreSQL connection string."
    )


def _build_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if ":memory:" in url or url in ("sqlite://", "sqlite+pysqlite://"):
            # Share one in-memory database across all sessions.
            kwargs["poolclass"] = StaticPool
        sqlite_engine = create_engine(url, **kwargs)

        @event.listens_for(sqlite_engine, "connect")
        def _enable_sqlite_foreign_keys(dbapi_connection, _record):
            # SQLite does not enforce foreign keys unless asked to.
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return sqlite_engine

    return create_engine(url, pool_pre_ping=True)


engine = _build_engine(DATABASE_URL)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    """Yield one session per request; roll back on error, always close."""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
