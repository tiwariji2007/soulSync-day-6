# Day 2 endpoint testing: `PUT /journals/{journal_id}`

The Day 2 FastAPI CRUD backend (copied from the sibling `soulsync-api/backend`)
already had 106 tests across users, moods and journals. For this task I picked
**`PUT /journals/{journal_id}`** and wrote a focused suite in
[`tests/test_put_journal.py`](tests/test_put_journal.py) (42 test cases), then reviewed it.

## Endpoint contract

| Situation | Expected |
|---|---|
| Valid body, entry exists | `200` with full `JournalRead`; title/content replaced and persisted; `user_id` and `created_at` unchanged; `updated_at` moves forward |
| Entry does not exist (never existed or deleted) | `404 {"detail": "Journal entry not found"}`, no row created |
| Invalid path id (`0`, `-1`, `abc`, `1.5`, out of range) | `422` on `["path", "journal_id"]` |
| Invalid body (missing/blank/too long/wrong type/`null`/non-object/unknown field such as `user_id`) | `422`, stored row unchanged |

## What the suite covers

- **Success:** full response shape; persistence checked through the API and directly in the database; whitespace stripping; length boundaries (1/200 title, 1/20 000 content); Unicode; identical-value updates; idempotent repeats; other entries (same user and another user) untouched.
- **Missing records:** unknown id, deleted entry, no accidental upsert, largest valid id (`2**31-1`) is `404`.
- **Invalid input:** 12 invalid bodies, each asserting the *specific* field in the error `loc` and that the row did not change; 5 non-object/malformed JSON bodies; 4 invalid path ids; body validation happens before the lookup (`422`, not `404`).
- **Edge cases:** an entry cannot be moved to another user via `user_id`; out-of-range ids (`2**31`, `2**63`, `10**30`).

## Review findings

I reviewed the suite for assertion strength, isolation, mocking and coverage.

| # | Finding | Type | Action |
|---|---|---|---|
| 1 | **Real bug:** `PUT /journals/9223372036854775808` returned **HTTP 500**. `RecordId` only had `gt=0`, so SQLite raised `OverflowError`. PostgreSQL would instead return 404, so behaviour depended on the database. The same gap existed for body `user_id` and the `?user_id=` list filters. | Product bug | Fixed: ids are bounded to the INTEGER range (`le=2**31-1`) in `routes/common.py`, `schemas.py`, `routes/journals.py`, `routes/moods.py`. Out-of-range ids now return `422`. Regression tests added. |
| 2 | `test_update_moves_updated_at_forward…` was **vacuous**: the row was backdated to 2020 and the test asserted `updated_at > 2020`. That passes even if the endpoint never touches `updated_at`, because the creation timestamp is already later. | Weak test | Fixed: the test now asserts the backdate is visible through `GET` before the `PUT`, so only a real update can make it pass. |
| 3 | `test_update_returns_full_updated_record` compared `updated_at` with **itself** (`"updated_at": r.json()["updated_at"]`). | Tautological assertion | Fixed: asserts the exact key set, a timezone-aware timestamp and `updated_at >= created_at`. |
| 4 | `test_update_missing_entry_does_not_create_one` never asserted the response status. | Missing assertion | Fixed: asserts `404`. |
| 5 | The first out-of-range test accepted `404 or 422`, so it could not tell correct validation from a lucky lookup. | Loose assertion | Fixed: requires exactly `422` on `["path", "journal_id"]`. |
| 6 | `test_update_rejects_non_object_bodies` checked only the status code. | Weak test | Fixed: also checks the stored row is unchanged. |
| 7 | Existing `test_journals.py::test_update_journal_bumps_updated_at` relied on `time.sleep(0.01)` and string comparison of timestamps. With a coarse system clock, two timestamps 10 ms apart can be equal, which makes the test flaky. | Flaky test (pre-existing) | Fixed: uses the same deterministic backdate technique. |

**Isolation:** good. The autouse `fresh_db` fixture drops and recreates all tables around every test, and `conftest.py` forces an in-memory SQLite URL before the app is imported (with an assertion that refuses non-SQLite engines). Fixtures create their own users and entries, and no test depends on ids from another test. The full suite passed three consecutive runs.

**Mocking:** none needed, and that's deliberate. Tests drive the real FastAPI app, real Pydantic validation and real SQLAlchemy through `TestClient`, so nothing that matters is faked. The trade-off is that SQLite stands in for PostgreSQL: finding 1 is exactly the kind of difference this can hide. Database-specific behaviour (timezone storage, integer overflow, constraint error text) is **not** verified against PostgreSQL by this suite.

**Coverage** (`pytest tests/test_put_journal.py --cov=routes --cov-branch`): `routes/journals.py` 95%, `routes/common.py` 92%. The only missed lines belong to other endpoints (list filter, `ensure_user_exists`). `update_journal` and `get_or_404` are fully covered. `schemas.py` is 100% covered.

## Results

```
pytest                              -> 148 passed (106 existing + 42 new)
pytest tests/test_put_journal.py    -> 42 passed
```

## How to run

```bash
cd day2-backend
python -m venv .venv
.venv\Scripts\activate            # Windows   (source .venv/bin/activate elsewhere)
pip install -r requirements.txt
pytest                            # full suite
pytest tests/test_put_journal.py --cov=routes --cov-branch --cov-report=term-missing
```

No database or `.env` is needed for the tests.
