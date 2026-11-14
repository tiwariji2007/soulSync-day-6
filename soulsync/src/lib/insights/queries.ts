import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/src/db";
import { journals, moods } from "@/src/db/schema";

/**
 * Query builders for one user's entries created at or after `since`.
 * Both queries filter by the authenticated user's id, so one user's data can
 * never reach another user's weekly summary.
 */
export function weeklyEntriesQueries(userId: string, since: Date) {
  return {
    moods: db
      .select({ mood: moods.mood, note: moods.note, createdAt: moods.createdAt })
      .from(moods)
      .where(and(eq(moods.userId, userId), gte(moods.createdAt, since)))
      .orderBy(desc(moods.createdAt)),
    journals: db
      .select({
        title: journals.title,
        content: journals.content,
        createdAt: journals.createdAt,
      })
      .from(journals)
      .where(and(eq(journals.userId, userId), gte(journals.createdAt, since)))
      .orderBy(desc(journals.createdAt)),
  };
}
