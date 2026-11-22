import { Suspense } from "react";
import { Dashboard } from "@/components/Dashboard";

// The whole app is one client-side dashboard; this server component just mounts it.
//
// <Suspense> is required because Dashboard reads the URL query string
// (useSearchParams). A statically-built page has no query string at build time,
// so Next needs a boundary to know where to wait for it on the client.
// Without it, `next build` fails.
export default function Home() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}
