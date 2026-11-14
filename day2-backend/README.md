# SoulSync Backend (FastAPI + PostgreSQL)

A standalone REST API for SoulSync **users**, **mood entries** and **journal entries**,
built with FastAPI, SQLAlchemy 2 ORM and Pydantic v2.

This folder is fully independent of the rest of the repository: it has its own
`requirements.txt`, virtual environment, `.env` and database. It does not import or
modify the existing root-level API, Docker setup or database.

## Project structure

```
backend/
├── main.py            # FastAPI app, router registration, table creation on startup
├── database.py        # Engine, session factory, get_db() dependency
├── models.py          # SQLAlchemy ORM models (users, mood_entries, journal_entries)
├── schemas.py         # Pydantic request/response schemas and validation rules
├── routes/
│   ├── common.py      # Pagination params, 404 helper, user-exists check
│   ├── users.py
│   ├── moods.py
│   └── journals.py
├── tests/             # pytest suite (runs on in-memory SQLite)
├── .env.example
├── pytest.ini
└── requirements.txt
```

## 1. Setup

Requires Python 3.11+ (developed on 3.14) and PostgreSQL.

```bash
cd day2-backend
python -m venv .venv

# Windows (PowerShell)
.\.venv\Scripts\Activate.ps1
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## 2. Database configuration

Create a **dedicated** database for this backend. Do not point it at the database
used by the older root-level API: that database already has a `journal_entries`
table without an `updated_at` column, and this backend never alters existing tables.

```sql
-- in psql, as a superuser
CREATE USER soulsync_app WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE soulsync_backend OWNER soulsync_app;
```

Copy the example env file and fill in your values:

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

```
DATABASE_URL=postgresql+psycopg://soulsync_app:choose-a-strong-password@localhost:5432/soulsync_backend
```

`.env` is git-ignored. Credentials are read only from the environment, never from source.
`database.py` loads `backend/.env` only, and a real environment variable overrides it.

Tables are created automatically on startup (`CREATE TABLE IF NOT EXISTS` semantics).
Existing tables are never altered or dropped.

### Schema

| Table             | Columns |
|-------------------|---------|
| `users`           | `id` PK, `name` varchar(100) not null, `email` varchar(255) unique not null, `created_at` timestamptz |
| `mood_entries`    | `id` PK, `user_id` FK → users.id (ON DELETE CASCADE), `mood` varchar(50) not null, `note` varchar(1000) null, `created_at` timestamptz |
| `journal_entries` | `id` PK, `user_id` FK → users.id (ON DELETE CASCADE), `title` varchar(200) not null, `content` text not null, `created_at`, `updated_at` timestamptz |

## 3. Start the server

```bash
cd day2-backend
uvicorn main:app --reload
```

- API: http://127.0.0.1:8000
- Interactive docs (Swagger): http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/health

## 4. Run the tests

```bash
cd day2-backend
pytest
```

The tests **always** use an in-memory SQLite database. `tests/conftest.py` overwrites
`DATABASE_URL` before the app is imported and refuses to run if the engine is not
SQLite. Your PostgreSQL data is never touched. Each test starts with empty tables.

## API reference

### Status codes

| Code | When |
|------|------|
| 200  | Successful read or update |
| 201  | Successful creation |
| 204  | Successful deletion (empty body) |
| 404  | The record in the URL does not exist |
| 409  | Email already used by another user |
| 422  | Invalid input: missing or wrong-typed fields, length limits, invalid email, unknown fields, bad pagination values, or a `user_id` that refers to a non-existent user |

Errors are returned as JSON: `{"detail": "User not found"}` or, for validation
errors, `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`.

### Validation rules

- **User:** `name` 1–100 chars, `email` must be a valid address (≤255 chars, stored lower-case, unique).
- **Mood:** `user_id` positive integer of an existing user, `mood` 1–50 chars, `note` optional ≤1000 chars.
- **Journal:** `user_id` positive integer of an existing user, `title` 1–200 chars, `content` 1–20 000 chars.
- Surrounding whitespace is stripped, so `"   "` is rejected for required strings.
- Unknown fields in a request body are rejected with 422.
- `PUT` is a full replacement: all required fields must be sent. For moods, omitting
  `note` clears it. The owning `user_id` of a mood or journal entry cannot be changed.

### Pagination

All list endpoints accept `skip` (default `0`, min `0`) and `limit` (default `20`,
min `1`, max `100`). Results are ordered by `id`. `/moods` and `/journals` also accept
an optional `user_id` filter.

## Testing every endpoint with curl

The commands below use bash/macOS/Linux quoting. They also work in **Git Bash** on Windows.
For PowerShell, see the note at the end of this section.
Run them in order on a fresh database: the first user created gets id `1` and is deleted
last. With existing data, use the IDs returned by your own create calls.

### Health

```bash
curl -i http://127.0.0.1:8000/health
```

### Users

```bash
# Create a user -> 201
curl -i -X POST http://127.0.0.1:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Asha Verma", "email": "asha@example.com"}'

# List users (paginated) -> 200
curl -i "http://127.0.0.1:8000/users?skip=0&limit=10"

# Get one user -> 200
curl -i http://127.0.0.1:8000/users/1

# Replace a user -> 200
curl -i -X PUT http://127.0.0.1:8000/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Asha V.", "email": "asha.v@example.com"}'
```

`DELETE /users/{id}` comes last, after the mood and journal examples, because it also
deletes that user's entries.

### Mood entries

```bash
# Create a mood entry -> 201
curl -i -X POST http://127.0.0.1:8000/moods \
  -H "Content-Type: application/json" \
  -d '{"user_id": 1, "mood": "happy", "note": "Finished my project"}'

# List mood entries (paginated, optional user filter) -> 200
curl -i "http://127.0.0.1:8000/moods?skip=0&limit=10"
curl -i "http://127.0.0.1:8000/moods?user_id=1"

# Get one mood entry -> 200
curl -i http://127.0.0.1:8000/moods/1

# Replace a mood entry -> 200
curl -i -X PUT http://127.0.0.1:8000/moods/1 \
  -H "Content-Type: application/json" \
  -d '{"mood": "calm", "note": "Evening walk"}'

# Delete a mood entry -> 204
curl -i -X DELETE http://127.0.0.1:8000/moods/1
```

### Journal entries

```bash
# Create a journal entry -> 201
curl -i -X POST http://127.0.0.1:8000/journals \
  -H "Content-Type: application/json" \
  -d '{"user_id": 1, "title": "First entry", "content": "Today I started journaling."}'

# List journal entries (paginated, optional user filter) -> 200
curl -i "http://127.0.0.1:8000/journals?skip=0&limit=10"
curl -i "http://127.0.0.1:8000/journals?user_id=1"

# Get one journal entry -> 200
curl -i http://127.0.0.1:8000/journals/1

# Replace a journal entry (updated_at changes) -> 200
curl -i -X PUT http://127.0.0.1:8000/journals/1 \
  -H "Content-Type: application/json" \
  -d '{"title": "First entry (edited)", "content": "Rewritten content."}'

# Delete a journal entry -> 204
curl -i -X DELETE http://127.0.0.1:8000/journals/1
```

### Error cases

```bash
# Missing record -> 404
curl -i http://127.0.0.1:8000/users/9999
curl -i http://127.0.0.1:8000/moods/9999
curl -i http://127.0.0.1:8000/journals/9999

# Invalid email -> 422
curl -i -X POST http://127.0.0.1:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Bad", "email": "not-an-email"}'

# Missing required field -> 422
curl -i -X POST http://127.0.0.1:8000/journals \
  -H "Content-Type: application/json" \
  -d '{"user_id": 1, "title": "No content"}'

# Referenced user does not exist -> 422
curl -i -X POST http://127.0.0.1:8000/moods \
  -H "Content-Type: application/json" \
  -d '{"user_id": 9999, "mood": "sad"}'

# Invalid pagination -> 422
curl -i "http://127.0.0.1:8000/users?skip=-1"
curl -i "http://127.0.0.1:8000/users?limit=500"

# Duplicate email -> 409
curl -i -X POST http://127.0.0.1:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Someone else", "email": "asha.v@example.com"}'
```

### Delete the user

```bash
# Delete a user (also deletes their mood and journal entries) -> 204
curl -i -X DELETE http://127.0.0.1:8000/users/1

# Confirm it is gone -> 404
curl -i http://127.0.0.1:8000/users/1
```

### PowerShell note

In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Call `curl.exe`
instead. Its inline JSON quoting is fragile, so put the body in a file and send it with
`--data-binary "@file"`:

```powershell
'{"name": "Asha Verma", "email": "asha@example.com"}' | Out-File -Encoding ascii user.json
curl.exe -i -X POST "http://127.0.0.1:8000/users" -H "Content-Type: application/json" --data-binary "@user.json"
curl.exe -i "http://127.0.0.1:8000/users?skip=0&limit=10"
curl.exe -i -X DELETE "http://127.0.0.1:8000/users/1"
```
