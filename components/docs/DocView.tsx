// Renders one tab's doc page. A server component: no JavaScript is sent to the
// browser for it, which is why the docs load instantly.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DOCS, type TabDoc } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function DocView({ doc }: { doc: TabDoc }) {
  return (
    <article className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6 sm:px-6">
      {/* Back to the app, landing on the tab this page documents. */}
      <Link
        href={doc.slug === "overview" ? "/" : `/?tab=${doc.slug}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the app
      </Link>

      {/* Jump between the tab docs. */}
      <nav aria-label="Documentation pages" className="mt-4 flex flex-wrap gap-1.5">
        {DOCS.map((d) => (
          <Link
            key={d.slug}
            href={`/docs/${d.slug}`}
            aria-current={d.slug === doc.slug ? "page" : undefined}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              d.slug === doc.slug && "border-primary/50 bg-primary/10 text-foreground",
            )}
          >
            {d.title}
          </Link>
        ))}
      </nav>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{doc.title}</h1>
      <p className="mt-1 text-base text-muted-foreground">{doc.tagline}</p>

      {/* The 30-second path: three things to do right now. */}
      <section aria-labelledby="try-it" className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-5">
        <h2 id="try-it" className="text-sm font-semibold uppercase tracking-wide text-primary">
          Try it in 30 seconds
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          {doc.tryIt.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      {doc.sections.map((s) => (
        <section key={s.heading} className="mt-6">
          <h2 className="text-base font-semibold">{s.heading}</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {s.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}

      <section className="mt-8 border-t pt-5">
        <h2 className="text-sm font-semibold">Where the code is</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {doc.files.map((f) => (
            <li key={f.path} className="flex flex-wrap gap-x-2">
              <code className="font-mono text-xs text-foreground">{f.path}</code>
              <span className="text-muted-foreground">{f.what}</span>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
