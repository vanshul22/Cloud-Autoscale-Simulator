// /docs  —  index of the tab docs.

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DOCS } from "@/lib/docs";

export const metadata: Metadata = { title: "Docs · Cloud Autoscale Simulator" };

export default function DocsIndex() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the app
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-1 text-muted-foreground">One short page per tab. Each takes about 30 seconds to read.</p>
      <ul className="mt-6 space-y-3">
        {DOCS.map((d) => (
          <li key={d.slug}>
            <Link
              href={`/docs/${d.slug}`}
              className="block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-medium">{d.title}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">{d.tagline}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
