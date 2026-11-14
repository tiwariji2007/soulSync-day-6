
"use client";

import { FormEvent, useState } from "react";

type Source = {
  heading: string;
  similarity: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

export default function FAQPage() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hi! I'm the SoulSync FAQ assistant. Ask me anything about SoulSync, mood tracking, journals, or Weekly Insights.",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const currentQuestion = question.trim();

    if (!currentQuestion || loading) return;

    setQuestion("");
    setError("");

    setMessages((previous) => [
      ...previous,
      { role: "user", content: currentQuestion },
    ]);

    setLoading(true);

    try {
      const response = await fetch("/api/faq", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: currentQuestion,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Unable to get an answer. Please try again."
        );
      }

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: data.answer || "I don't know.",
          sources: data.sources || [],
        },
      ]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-white">
      <div className="mx-auto flex max-w-3xl flex-col">
        <header className="mb-8 text-center">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.25em] text-violet-400">
            SoulSync
          </p>

          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            FAQ Assistant
          </h1>

          <p className="mt-3 text-sm text-slate-400 sm:text-base">
            Ask questions and get answers from the SoulSync knowledge base.
          </p>
        </header>

        <section className="flex min-h-[500px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <div>
              <h2 className="font-semibold">SoulSync Support</h2>
              <p className="mt-1 text-xs text-slate-400">
                Answers only from the SoulSync FAQ (pgvector search)
              </p>
            </div>

            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
              AI Assistant
            </span>
          </div>

          <div
            className="flex-1 space-y-5 overflow-y-auto p-5"
            aria-live="polite"
          >
            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex ${
                  message.role === "user"
                    ? "justify-end"
                    : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    message.role === "user"
                      ? "rounded-br-sm bg-violet-600 text-white"
                      : "rounded-bl-sm border border-slate-700 bg-slate-800 text-slate-100"
                  }`}
                >
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {message.content}
                  </p>

                  {message.sources && message.sources.length > 0 && (
                    <div className="mt-3 border-t border-slate-600 pt-3">
                      <p className="mb-2 text-xs font-semibold text-violet-300">
                        Relevant FAQ sources
                      </p>

                      {message.sources.map((source, sourceIndex) => (
                        <div
                          key={`${source.heading}-${sourceIndex}`}
                          className="mb-2 text-xs text-slate-300"
                        >
                          <p>{source.heading}</p>
                          <p className="mt-1 text-slate-500">
                            Similarity:{" "}
                            {(source.similarity * 100).toFixed(1)}%
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-300">
                  Searching FAQs and generating an answer...
                </div>
              </div>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="border-t border-red-900/50 bg-red-950/40 px-5 py-3 text-sm text-red-300"
            >
              {error}
            </p>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex gap-3 border-t border-slate-800 p-4"
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a question about SoulSync..."
              maxLength={1000}
              disabled={loading}
              aria-label="Your question"
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-violet-500 disabled:opacity-50"
            />

            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "..." : "Send"}
            </button>
          </form>
        </section>

        <p className="mt-4 text-center text-xs text-slate-500">
          Answers are generated using the available SoulSync FAQ documents.
        </p>
      </div>
    </main>
  );
}
