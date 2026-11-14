import "server-only";
import { db } from "@/src/db";
import { aiUsageLogs } from "@/src/db/schema";
import { auth } from "@/src/lib/auth";
import { weeklyEntriesQueries } from "@/src/lib/insights/queries";
import type { GetSessionUser } from "./http";
import { createRateLimiter, positiveIntFromEnv } from "./rate-limit";
import { safeSink, type UsageSink } from "./usage";

export const getSessionUser: GetSessionUser = async (headers) => {
  const session = await auth.api.getSession({ headers });
  return session ? { id: session.user.id } : null;
};

export const logAiUsage: UsageSink = safeSink(async (entry) => {
  await db.insert(aiUsageLogs).values(entry);
});

export const faqRateLimit = createRateLimiter({
  maxRequests: positiveIntFromEnv("FAQ_RATE_LIMIT_PER_MINUTE", 10),
  windowMs: 60_000,
});

export const insightsRateLimit = createRateLimiter({
  maxRequests: positiveIntFromEnv("INSIGHTS_RATE_LIMIT_PER_MINUTE", 5),
  windowMs: 60_000,
});

export async function loadWeeklyEntries(userId: string, since: Date) {
  const queries = weeklyEntriesQueries(userId, since);
  const [moodRows, journalRows] = await Promise.all([queries.moods, queries.journals]);
  return { moods: moodRows, journals: journalRows };
}
