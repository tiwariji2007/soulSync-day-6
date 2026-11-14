from typing import Annotated

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import select

from models import MoodEntry
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
from schemas import MoodCreate, MoodRead, MoodUpdate

router = APIRouter(prefix="/moods", tags=["moods"])


@router.post("", response_model=MoodRead, status_code=status.HTTP_201_CREATED)
def create_mood(payload: MoodCreate, db: DbSession):
    ensure_user_exists(db, payload.user_id)
    mood = MoodEntry(**payload.model_dump())
    db.add(mood)
    db.commit()
    db.refresh(mood)
    return mood


@router.get("", response_model=list[MoodRead])
def list_moods(
    db: DbSession,
    skip: Skip = 0,
    limit: Limit = DEFAULT_LIMIT,
    user_id: Annotated[int | None, Query(gt=0, le=MAX_DB_ID, description="Filter by user")] = None,
):
    stmt = select(MoodEntry)
    if user_id is not None:
        stmt = stmt.where(MoodEntry.user_id == user_id)
    stmt = stmt.order_by(MoodEntry.id).offset(skip).limit(limit)
    return db.scalars(stmt).all()


@router.get("/{mood_id}", response_model=MoodRead)
def get_mood(mood_id: RecordId, db: DbSession):
    return get_or_404(db, MoodEntry, mood_id, "Mood entry")


@router.put("/{mood_id}", response_model=MoodRead)
def update_mood(mood_id: RecordId, payload: MoodUpdate, db: DbSession):
    mood = get_or_404(db, MoodEntry, mood_id, "Mood entry")
    mood.mood = payload.mood
    mood.note = payload.note
    db.commit()
    db.refresh(mood)
    return mood


@router.delete("/{mood_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mood(mood_id: RecordId, db: DbSession):
    mood = get_or_404(db, MoodEntry, mood_id, "Mood entry")
    db.delete(mood)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
