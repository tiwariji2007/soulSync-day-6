from typing import Annotated

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import select

from models import JournalEntry
from routes.common import (
    DEFAULT_LIMIT,
    MAX_DB_ID,
    DbSession,
    Limit,
    RecordId,
    Skip,
    ensure_user_exists,
    get_or_404,
)
from schemas import JournalCreate, JournalRead, JournalUpdate

router = APIRouter(prefix="/journals", tags=["journals"])


@router.post("", response_model=JournalRead, status_code=status.HTTP_201_CREATED)
def create_journal(payload: JournalCreate, db: DbSession):
    ensure_user_exists(db, payload.user_id)
    journal = JournalEntry(**payload.model_dump())
    db.add(journal)
    db.commit()
    db.refresh(journal)
    return journal


@router.get("", response_model=list[JournalRead])
def list_journals(
    db: DbSession,
    skip: Skip = 0,
    limit: Limit = DEFAULT_LIMIT,
    user_id: Annotated[int | None, Query(gt=0, le=MAX_DB_ID, description="Filter by user")] = None,
):
    stmt = select(JournalEntry)
    if user_id is not None:
        stmt = stmt.where(JournalEntry.user_id == user_id)
    stmt = stmt.order_by(JournalEntry.id).offset(skip).limit(limit)
    return db.scalars(stmt).all()


@router.get("/{journal_id}", response_model=JournalRead)
def get_journal(journal_id: RecordId, db: DbSession):
    return get_or_404(db, JournalEntry, journal_id, "Journal entry")


@router.put("/{journal_id}", response_model=JournalRead)
def update_journal(journal_id: RecordId, payload: JournalUpdate, db: DbSession):
    journal = get_or_404(db, JournalEntry, journal_id, "Journal entry")
    journal.title = payload.title
    journal.content = payload.content
    db.commit()  # updated_at is refreshed by the column's onupdate hook
    db.refresh(journal)
    return journal


@router.delete("/{journal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_journal(journal_id: RecordId, db: DbSession):
    journal = get_or_404(db, JournalEntry, journal_id, "Journal entry")
    db.delete(journal)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
