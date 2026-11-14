export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
};

export type RateLimiter = (key: string) => RateLimitResult;

/**
 * Fixed-window, in-memory rate limiter keyed by user id.
 *
 * State lives in this process only: it resets on restart and is not shared
 * between server instances. Use a shared store (e.g. Redis) for multi-instance
 * deployments.
 */
export function createRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (key) => {
    const current = now();

    if (windows.size > 10_000) {
      for (const [entryKey, entry] of windows) {
        if (current >= entry.resetAt) windows.delete(entryKey);
      }
    }

    const entry = windows.get(key);

    if (!entry || current >= entry.resetAt) {
      windows.set(key, { count: 1, resetAt: current + options.windowMs });
      return { allowed: true, remaining: options.maxRequests - 1, retryAfter: 0 };
    }

    if (entry.count >= options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - current) / 1000)),
      };
    }

    entry.count += 1;
    return {
      allowed: true,
      remaining: options.maxRequests - entry.count,
      retryAfter: 0,
    };
  };
}

export function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
