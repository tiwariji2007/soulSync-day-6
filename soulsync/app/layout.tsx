
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SoulSync | Your Mental Wellness Journal",
  description:
    "Track your moods, write journal entries, and discover your weekly emotional insights.",
};

export default function RootLayout({
  children,
}: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4">
            <Link
              href="/"
              className="text-xl font-bold text-blue-700"
            >
              SoulSync
            </Link>

            <div className="flex flex-wrap gap-4 text-sm font-medium text-slate-700">
              <Link href="/mood" className="hover:text-blue-600">
                Mood Logger
              </Link>

              <Link href="/journal" className="hover:text-blue-600">
                Journal
              </Link>

              <Link href="/history" className="hover:text-blue-600">
                History
              </Link>

              <Link
                href="/insights"
                className="font-semibold text-purple-700 hover:text-purple-900"
              >
                Weekly Insights
              </Link>
            </div>
          </nav>
        </header>

        {children}
      </body>
    </html>
  );
}
