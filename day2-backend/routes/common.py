"""Helpers shared by all routers."""

from typing import Annotated, TypeVar

from fastapi import Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from database import Base, get_db
from models import User

DEFAULT_LIMIT = 20
MAX_LIMIT = 100

DbSession = Annotated[Session, Depends(get_db)]
Skip = Annotated[int, Query(ge=0, le=1_000_000, description="Number of records to skip")]
Limit = Annotated[
    int,
    Query(ge=1, le=MAX_LIMIT, description=f"Maximum records to return (1-{MAX_LIMIT})"),
]
# Primary keys are SQL INTEGER columns (PostgreSQL int4). Bounding the path
# id rejects out-of-range values with 422 instead of letting the database
# driver raise (SQLite: OverflowError -> HTTP 500 for ids >= 2**63).
MAX_DB_ID = 2**31 - 1
RecordId = Annotated[int, Path(gt=0, le=MAX_DB_ID)]

ModelT = TypeVar("ModelT", bound=Base)


def get_or_404(db: Session, model: type[ModelT], record_id: int, label: str) -> ModelT:
    record = db.get(model, record_id)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"{label} not found")
    return record


def ensure_user_exists(db: Session, user_id: int) -> None:
    """A body that references a missing user is invalid input -> 422."""
    if db.get(User, user_id) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[
                {
                    "loc": ["body", "user_id"],
                    "msg": f"User with id {user_id} does not exist",
                    "type": "foreign_key_violation",
                }
            ],
        )
