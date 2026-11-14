"""SoulSync backend - FastAPI application entry point.

Run from the backend/ directory:
    uvicorn main:app --reload
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

import models  # noqa: F401  (registers tables on Base.metadata)
from database import Base, engine
from routes import journals_router, moods_router, users_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Creates missing tables only; never alters or drops existing ones.
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="SoulSync API",
    version="2.0.0",
    description="Users, mood entries and journal entries.",
    lifespan=lifespan,
)

app.include_router(users_router)
app.include_router(moods_router)
app.include_router(journals_router)


@app.get("/health", tags=["health"])
def health():
    return {"status": "ok"}
