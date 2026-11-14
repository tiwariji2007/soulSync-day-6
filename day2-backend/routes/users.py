from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from models import User
from routes.common import DEFAULT_LIMIT, DbSession, Limit, RecordId, Skip, get_or_404
from schemas import UserCreate, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

EMAIL_TAKEN = "A user with this email already exists"


def _email_taken(db: DbSession, email: str, exclude_id: int | None = None) -> bool:
    stmt = select(User.id).where(User.email == email)
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return db.scalar(stmt) is not None


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: DbSession):
    if _email_taken(db, payload.email):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)
    user = User(**payload.model_dump())
    db.add(user)
    try:
        db.commit()
    except IntegrityError:  # race with a concurrent insert
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)
    db.refresh(user)
    return user


@router.get("", response_model=list[UserRead])
def list_users(db: DbSession, skip: Skip = 0, limit: Limit = DEFAULT_LIMIT):
    stmt = select(User).order_by(User.id).offset(skip).limit(limit)
    return db.scalars(stmt).all()


@router.get("/{user_id}", response_model=UserRead)
def get_user(user_id: RecordId, db: DbSession):
    return get_or_404(db, User, user_id, "User")


@router.put("/{user_id}", response_model=UserRead)
def update_user(user_id: RecordId, payload: UserUpdate, db: DbSession):
    user = get_or_404(db, User, user_id, "User")
    if _email_taken(db, payload.email, exclude_id=user_id):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)
    user.name = payload.name
    user.email = payload.email
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: RecordId, db: DbSession):
    user = get_or_404(db, User, user_id, "User")
    db.delete(user)  # cascades to the user's mood and journal entries
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
