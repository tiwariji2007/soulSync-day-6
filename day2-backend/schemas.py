"""Pydantic request/response schemas.

All request bodies reject unknown fields (HTTP 422) and strip surrounding
whitespace from strings, so "   " does not count as a valid required value.
"""

from datetime import datetime, timezone
from typing import Annotated

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Mood = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Content = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20000)]
# Matches the INTEGER primary key range (PostgreSQL int4).
UserId = Annotated[int, Field(gt=0, le=2**31 - 1, strict=True)]


def _as_utc(value: datetime) -> datetime:
    # Timestamps are stored in UTC. SQLite drops tzinfo, so re-attach it
    # to keep the JSON output identical on SQLite and PostgreSQL.
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


UTCDateTime = Annotated[datetime, AfterValidator(_as_utc)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------- Users ----------

class UserBase(RequestModel):
    name: Name
    email: Annotated[EmailStr, Field(max_length=255)]

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.lower()


class UserCreate(UserBase):
    pass


class UserUpdate(UserBase):
    """PUT replaces the whole user, so every field is required."""


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    created_at: UTCDateTime


# ---------- Mood entries ----------

class MoodCreate(RequestModel):
    user_id: UserId
    mood: Mood
    note: Note | None = None


class MoodUpdate(RequestModel):
    """PUT replaces mood and note. The owning user cannot be changed."""

    mood: Mood
    note: Note | None = None


class MoodRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    mood: str
    note: str | None
    created_at: UTCDateTime


# ---------- Journal entries ----------

class JournalCreate(RequestModel):
    user_id: UserId
    title: Title
    content: Content


class JournalUpdate(RequestModel):
    """PUT replaces title and content. The owning user cannot be changed."""

    title: Title
    content: Content


class JournalRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    title: str
    content: str
    created_at: UTCDateTime
    updated_at: UTCDateTime
