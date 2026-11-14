
"use client";

import { useCallback, useEffect, useState } from "react";

type WeeklyStats = {
  moods: number;
  journals: number;
  topMood: string;
  themes: string[];
  moodDistribution: Record<string, number>;
};

export default function InsightsPage() {
  const [summary, setSummary] = useState("");
  const [stats, setStats] = useState<WeeklyStats>({
    moods: 0,
    journals: 0,
    topMood: "Not recorded",
    themes: [],
    moodDistribution: {},
  });

  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");

  const loadInsights = useCallback(async () => {
    setLoading(true);
    setError("");
    setSummary("");
    setSource("");

    try {
      const response = await fetch("/api/insights/weekly", {
        cache: "no-store",
      });

      if (!response.ok) {
        let message =
          response.status === 401
            ? "Please log in to view your weekly insights."
            : "Unable to load weekly insights.";

        try {
          const data: unknown = await response.json();
          if (
            data &&
            typeof data === "object" &&
            "error" in data &&
            typeof data.error === "string"
          ) {
            message = data.error;
          }
        } catch {
          // Keep the default message.
        }

        throw new Error(message);
      }

      setSource(response.headers.get("X-Insights-Source") ?? "");

      const moodDistributionHeader =
        response.headers.get("X-Weekly-Mood-Distribution");

      let moodDistribution: Record<string, number> = {};

      if (moodDistributionHeader) {
        try {
          const parsed: unknown = JSON.parse(
            decodeURIComponent(moodDistributionHeader)
          );

          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            moodDistribution = parsed as Record<string, number>;
          }
        } catch {
          moodDistribution = {};
        }
      }

      const themesHeader = response.headers.get("X-Weekly-Themes");

      setStats({
        moods: Number(
          response.headers.get("X-Weekly-Mood-Count") ?? 0
        ),
        journals: Number(
          response.headers.get("X-Weekly-Journal-Count") ?? 0
        ),
        topMood: decodeURIComponent(
          response.headers.get("X-Weekly-Top-Mood") ?? "Not recorded"
        ),
        themes: themesHeader
          ? decodeURIComponent(themesHeader)
              .split(",")
              .map((theme) => theme.trim())
              .filter(Boolean)
          : [],
        moodDistribution,
      });

      if (!response.body) {
        throw new Error("Streaming is not supported by this response.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        setSummary((previous) => previous + decoder.decode(value, {
          stream: true,
        }));
      }

      const remaining = decoder.decode();

      if (remaining) {
        setSummary((previous) => previous + remaining);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadInsights();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadInsights]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-indigo-50 px-5 py-10">
      <div className="mx-auto max-w-4xl">

        <header className="mb-8">
          <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-purple-600">
            SoulSync
          </p>

          <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">
            Weekly Insights
          </h1>

          <p className="mt-2 text-gray-600">
            Understand your emotions and reflect on your week.
          </p>

          <p className="mt-2 text-sm text-gray-500">
            Your last seven days of mood and journal activity
          </p>
        </header>

        {/* Weekly statistics */}
        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">

          <div className="rounded-2xl border border-purple-100 bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-500">Mood entries</p>
            <p className="mt-2 text-3xl font-bold text-purple-700">
              {stats.moods}
            </p>
          </div>

          <div className="rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-500">Journal entries</p>
            <p className="mt-2 text-3xl font-bold text-indigo-700">
              {stats.journals}
            </p>
          </div>

          <div className="rounded-2xl border border-pink-100 bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-500">Most frequent mood</p>
            <p className="mt-2 break-words text-2xl font-bold text-pink-700">
              {stats.topMood}
            </p>
          </div>

        </section>

        {/* Mood distribution */}
        <section className="mb-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-bold text-gray-900">
            Mood distribution
          </h2>

          {Object.keys(stats.moodDistribution).length > 0 ? (
            <div className="space-y-4">
              {Object.entries(stats.moodDistribution).map(
                ([mood, count]) => {
                  const percentage = stats.moods > 0
                    ? Math.round((count / stats.moods) * 100)
                    : 0;

                  return (
                    <div key={mood}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="font-medium capitalize text-gray-700">
                          {mood}
                        </span>

                        <span className="text-gray-500">
                          {count} ({percentage}%)
                        </span>
                      </div>

                      <div className="h-3 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full bg-purple-500 transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          ) : (
            <p className="text-gray-500">
              Record your moods to see your weekly mood distribution.
            </p>
          )}
        </section>

        {/* Weekly reflection */}
        <section className="mb-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-bold text-gray-900">
            Your weekly reflection
          </h2>

          {loading && !summary && (
            <p className="animate-pulse text-gray-500">
              Gathering your weekly reflections...
            </p>
          )}

          {summary && (
            <div className="whitespace-pre-wrap leading-8 text-gray-700">
              {summary}

              {loading && (
                <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-purple-500" />
              )}
            </div>
          )}

          {!loading && (source === "ai" || source === "fallback") && (
            <p className="mt-4 text-xs text-gray-500">
              {source === "ai"
                ? "Written by AI from your own entries this week."
                : "The AI summary is unavailable right now, so this is a standard summary of your week."}
            </p>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && (
            <button
              onClick={() => void loadInsights()}
              className="mt-6 rounded-xl bg-purple-600 px-5 py-3 font-semibold text-white transition hover:bg-purple-700"
            >
              Refresh insights
            </button>
          )}
        </section>

        {/* Journal themes */}
        <section className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-xl font-bold text-gray-900">
            Recurring journal themes
          </h2>

          {stats.themes.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {stats.themes.map((theme) => (
                <span
                  key={theme}
                  className="rounded-full bg-purple-100 px-4 py-2 text-sm font-medium capitalize text-purple-700"
                >
                  {theme}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">
              Your recurring themes will appear here when you add journal entries.
            </p>
          )}
        </section>

        <p className="mt-6 text-center text-sm text-gray-500">
          Your reflections are private and belong to your account.
        </p>

      </div>
    </main>
  );
}
