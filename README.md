# SoulSync Day 6: AI features, RAG and endpoint testing

This repository has three independent projects. Each was copied from a working
sibling project (`../tactiq`, `../soulsync-frontend`, `../soulsync-api/backend`)
using only git-visible files, so no `.env` files, secrets, `node_modules` or build
output were copied. The original projects were not modified.

| Folder | Stack | What was added |
|---|---|---|
| [`tactiq/`](tactiq) | Next.js 16, chess.js, Stockfish (npm), Ollama | AI blunder coach: Stockfish facts, LLM explanation, strict JSON and chess-claim validation, deterministic fallback, usage logging, rate limiting |
| [`soulsync/`](soulsync) | Next.js 16, better-auth, Drizzle, PostgreSQL + pgvector, Ollama | Streaming AI weekly insights (user-scoped), pgvector FAQ RAG with similarity thresholds, `ai_usage_logs`, per-user rate limiting |
| [`day2-backend/`](day2-backend) | FastAPI, SQLAlchemy, pytest | Focused test suite for `PUT /journals/{id}`, review fixes, bug fix ([TEST_REVIEW.md](day2-backend/TEST_REVIEW.md)) |

---

## Prerequisites

- Node.js 22.18+ (scripts import `.ts` files via Node type stripping) and npm
- Python 3.11+ (developed on 3.14)
- [Ollama](https://ollama.com) running locally with the models:
  ```bash
  ollama pull qwen2.5:3b
  ollama pull nomic-embed-text
  ```
- For SoulSync: PostgreSQL 15+ **with the pgvector extension installed**
  (`CREATE EXTENSION vector` must succeed for the database user).

---

## 1. TactiQ AI coach (`tactiq/`)

### Setup
```bash
cd tactiq
npm install
cp .env.example .env.local      # optional; defaults work with local Ollama
npm run dev                     # http://localhost:3000
```

### Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Chat model for explanations |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | `10` / `60000` | Per-client limit |
| `LLM_INPUT_COST_PER_MTOK` / `LLM_OUTPUT_COST_PER_MTOK` | `0` | USD per million tokens for cost logging |
| `USAGE_LOG_DIR` | `./data` | Where `ai-usage.jsonl` is written (git-ignored) |

### How it works
1. The move is checked with chess.js (illegal move or invalid FEN gives `400`).
2. Stockfish analyses the best move and the played move (`searchmoves`) at depth 12.
   The move is classified by centipawn loss (mate scores are handled).
3. For **blunders**, the LLM gets only verified facts: engine lines, evaluations, the
   opponent's verified reply and a `KEY FACT` sentence. It must return JSON with exactly
   `move`, `why_bad` and `better_idea`.
4. `parseExplanation` enforces the JSON contract (keys, types, lengths, `move` equals
   the played move). `validateChessClaims` rejects:
   - SAN moves not in the verified lines
   - captures, losses or trades not backed by a verified capture
   - check or mate claims without a verified check
   - tactical motifs and threats it cannot verify (fork, pin, "king in danger", …)
   - "piece on square" claims that are false on the board
   - praise for a blunder
   - a `better_idea` without the engine's move
   - the engine move attributed to the opponent
5. On any LLM error, invalid JSON or rejected claim, the response uses the
   **deterministic engine-derived fallback** (`source: "fallback"`). Non-blunders use the
   engine text without calling the LLM (`source: "engine"`).

### API example
```bash
curl -X POST http://localhost:3000/api/explain-blunder \
  -H "Content-Type: application/json" \
  -d '{"fen":"rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2","playedMove":"Qg4"}'
```
```json
{
  "move": "Qg4",
  "why_bad": "The move Qg4 allows Black to capture the queen on g4 with Bxg4, resulting in a significant loss of material and a positional disadvantage for White.",
  "better_idea": "exd5",
  "moveQuality": "Blunder",
  "source": "llm",
  "engine": { "bestMove": "exd5", "evaluationBefore": "…", "evaluationAfter": "…", "evaluationDifference": "…", "principalVariation": "…", "playedVariation": "…" }
}
```
(The `why_bad` above is real `qwen2.5:3b` output that passed validation.)

| Status | Code | When |
|---|---|---|
| 200 | — | Explanation (LLM, engine or fallback) |
| 400 | `INVALID_JSON`, `INVALID_CHESS_INPUT` | Malformed body, bad FEN, illegal move, finished game |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 4 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not `application/json` |
| 429 | `RATE_LIMITED` | Limit exceeded (`Retry-After` header) |
| 503 / 504 | `ENGINE_UNAVAILABLE` / `ENGINE_TIMEOUT` | Stockfish failed / timed out |
| 500 | `INTERNAL_ERROR` | Unexpected; no internal details in the body |

Each response has an `X-Request-Id` header. Each request appends one line to
`data/ai-usage.jsonl` with `promptTokens`, `completionTokens`, `totalTokens`, `costUsd`,
`latencyMs`, `httpStatus`, `status` and `errorCode`. Prompts and outputs are not logged.

---

## 2 and 3. SoulSync weekly insights and FAQ RAG (`soulsync/`)

### Setup
```bash
cd soulsync
npm install
cp .env.example .env.local        # fill in DATABASE_URL, BETTER_AUTH_SECRET, ...
npm run db:migrate                # applies drizzle/0000..0004 (0004 enables pgvector)
npm run faq:seed                  # embeds data/faq.md into faq_chunks
npm run dev
```

### Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required at runtime) | PostgreSQL connection string |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | — | Auth (better-auth) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | — | Welcome email (optional; skipped with a logged error if unset) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | — | Payments (existing feature) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_CHAT_MODEL` | `qwen2.5:3b` | Insights and FAQ answers |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | 768-dim embeddings |
| `FAQ_RATE_LIMIT_PER_MINUTE` / `INSIGHTS_RATE_LIMIT_PER_MINUTE` | `10` / `5` | Per-user limits |
| `LLM_INPUT_COST_PER_MTOK` / `LLM_OUTPUT_COST_PER_MTOK` | `0` | Cost logging |

### Database migration (`drizzle/0004_faq_pgvector_and_ai_usage.sql`)
It is additive only. It runs `CREATE EXTENSION IF NOT EXISTS vector`, then creates
`faq_chunks` (`embedding vector(768)`, HNSW index with `vector_cosine_ops`, unique
`(source, chunk_index)`) and `ai_usage_logs`. No existing table is altered or dropped.
The older `faq_documents` / `faq_usage_logs` tables from the previous FAQ version are kept
but no longer used. A test asserts the migration contains no `DROP`, `TRUNCATE` or `DELETE FROM`.

### Weekly insights: `GET /api/insights/weekly`
- Requires a session (`401` otherwise). Mood and journal queries both filter by
  `user_id = session.user.id` and `created_at >= now - 7 days`.
- Weekly stats (counts, top mood, distribution, themes) come back in `X-Weekly-*` headers.
  The summary is **streamed** as `text/plain` while the LLM generates it (Ollama NDJSON
  stream, re-chunked to the browser). The `/insights` page renders it progressively.
- `X-Insights-Source` is `ai`, `fallback` (model unavailable before the first token, so the
  deterministic summary is streamed instead) or `summary` (no entries, so no LLM call).
  If the stream breaks midway, the partial text is kept and a note is appended.
  If the client disconnects, the upstream request is aborted.
- Errors: `401`, `429` (`Retry-After`), `500 DATA_LOAD_FAILED`.

```bash
curl -N http://localhost:3000/api/insights/weekly -H "Cookie: <better-auth session cookie>"
```

### FAQ RAG: `POST /api/faq`
1. The question (1–500 chars) is embedded with `search_query:` and `nomic-embed-text`.
2. pgvector search: `1 - (embedding <=> $q) >= 0.60 ORDER BY similarity DESC LIMIT 3`.
3. If no chunk passes, the answer is exactly `"I don't know."` and **the chat model is not called**.
4. Otherwise the model answers only from the retrieved chunks (strict system prompt,
   temperature 0). Any decline is normalised to exactly `"I don't know."`. An answer
   whose content words are less than 60% present in the retrieved text is treated as
   unsupported and replaced with `"I don't know."`.

```bash
curl -X POST http://localhost:3000/api/faq -H "Content-Type: application/json" \
  -H "Cookie: <session cookie>" -d '{"question":"Can other people read my journal?"}'
# {"answer":"No, only you can see your journal entries and moods as they are private to your account.",
#  "sources":[{"heading":"Who can see my moods and journal entries?","similarity":0.749}, ...]}
# (answer text is real qwen2.5:3b output from the live RAG test; see Verification status)
```
Errors: `400 INVALID_JSON/INVALID_QUESTION`, `401`, `429`, `503 LLM_UNAVAILABLE`,
`504 LLM_TIMEOUT`, `500 INTERNAL_ERROR`. No internal details are returned.

**Threshold calibration** (`npm run faq:calibrate`). This needs Ollama only, not a database,
and uses the same cosine math as pgvector's `<=>`. Results with `nomic-embed-text` on `data/faq.md`:

| Question set | Best-match similarity |
|---|---|
| 8 answerable questions | 0.615 – 0.897 |
| 7 off-topic questions | 0.433 – 0.554 |
| "Does SoulSync have an Android app?" (on-topic, not answerable) | 0.805 |

`MIN_SIMILARITY = 0.60` separates the two groups. The previous version's 0.45 would have
retrieved context for every off-topic question. On-topic but unanswerable questions can't
be filtered by similarity, so they rely on the strict prompt plus the grounding check.

### Usage logging (both AI endpoints)
Every request (success, fallback, rate-limited or error) inserts one row into
`ai_usage_logs`: `user_id, endpoint, model, prompt_tokens, completion_tokens, total_tokens,
cost_usd, latency_ms, http_status, status, error_code`. For the FAQ, `prompt_tokens`
includes the embedding tokens. Logging failures never fail the request, and their messages
are not printed, because they may contain connection strings.

---

## 4. Reliability and secrets
- All Ollama calls have timeouts and typed errors (`LLM_TIMEOUT` → 504, otherwise 503).
  Upstream bodies, URLs and stack traces are never returned.
- Rate limiting: fixed window, in memory, keyed per client IP (TactiQ) or per user and
  endpoint (SoulSync). It resets on restart and is not shared across instances.
- No secrets are committed: every `.env*` is ignored except `.env.example`
  templates with placeholders. Tests assert error bodies and logs don't contain
  injected secrets (`sk-…`, `postgres://user:pw@…`).

---

## 5. Day 2 endpoint tests (`day2-backend/`)
See [day2-backend/TEST_REVIEW.md](day2-backend/TEST_REVIEW.md) for the chosen endpoint
(`PUT /journals/{journal_id}`), the 42 new tests, the review findings and the bug they
uncovered (ids ≥ 2^63 caused HTTP 500).

---

## Testing

```bash
# TactiQ: unit + handler tests + real Stockfish integration test
cd tactiq && npm test
RUN_LLM_TESTS=1 npm test          # also runs the live Ollama test
npm run lint && npm run typecheck && npm run build

# SoulSync: unit + handler + streaming + SQL-shape tests (no database needed)
cd soulsync && npm test
RUN_LLM_TESTS=1 npm test          # also runs live RAG + streaming tests against Ollama
npm run lint && npx next typegen && npm run typecheck && npm run build

# Day 2 backend
cd day2-backend && pytest
```

`next build` for SoulSync works without a `.env.local`, but better-auth then warns about
a missing secret and base URL, and the `/admin` prerender logs a refused database
connection. Set the real variables for production builds.

### Verification status
| Check | Result |
|---|---|
| TactiQ tests | 95 passed, 1 skipped (live LLM, opt-in); live Ollama test also run and passed |
| SoulSync tests | 64 passed (+8 opt-in live Ollama tests, run and passed: real embeddings and chat, in-memory cosine search in place of pgvector, real NDJSON streaming) |
| Day 2 tests | 148 passed |
| ESLint, `tsc --noEmit`, `next build` | Pass for both Next.js apps |
| **PostgreSQL / pgvector at runtime** | **Not verified.** The local PostgreSQL 18 has no pgvector extension installed, so the migration, seed script and vector search were not run against a database. SQL text and parameters are verified with Drizzle's `.toSQL()`, and thresholds were calibrated with real embeddings. |

## Known limitations
- pgvector runtime behaviour is untested here (see above).
- In-memory rate limiting is per process.
- The chess-claim validator is conservative: it may reject correct explanations that use
  vocabulary it can't verify, which triggers the deterministic fallback.
- The grounding check is lexical; a paraphrased but correct answer could be replaced
  with "I don't know."
- Insights summaries are not fact-checked beyond prompt rules; the authoritative counts
  are in the response headers and stat cards.
