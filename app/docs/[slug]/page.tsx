// /docs/<slug>  —  one short documentation page per tab (e.g. /docs/cluster).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocView } from "@/components/docs/DocView";
import { DOCS, getDoc } from "@/lib/docs";

// Build one static HTML page per doc. Any other slug is a 404, not a runtime error.
export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}
export const dynamicParams = false;

// In Next.js 15 `params` is a Promise, so it has to be awaited.
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = getDoc((await params).slug);
  return { title: doc ? `${doc.title} docs · Cloud Autoscale Simulator` : "Docs" };
}

export default async function DocPage({ params }: Props) {
  const doc = getDoc((await params).slug);
  if (!doc) notFound();
  return <DocView doc={doc} />;
}
