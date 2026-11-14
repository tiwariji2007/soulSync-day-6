import type { RateLimitResult } from "./rate-limit";

export type SessionUser = { id: string };
export type GetSessionUser = (headers: Headers) => Promise<SessionUser | null>;

/** JSON error body with a stable machine-readable code and no internals. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit
): Response {
  return Response.json({ error: message, code }, { status, headers });
}

export function rateLimitedResponse(limit: RateLimitResult): Response {
  return jsonError(429, "RATE_LIMITED", "Too many requests. Please wait and try again.", {
    "Retry-After": String(limit.retryAfter),
  });
}
