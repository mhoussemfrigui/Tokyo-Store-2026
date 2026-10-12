import { NotFoundScene } from "@/components/not-found-scene";
import { getNotFoundConfig } from "@/lib/redirects/config";

// Render per-request so admin 404 copy edits (notfound.*) apply to
// truly-unmatched top-level routes too (else Next bakes the defaults at build).
export const dynamic = "force-dynamic";

// Custom branded 404. Rendered by Next for any unmatched route (root-level, so
// it sits outside the (shop) header/footer — the component is self-contained
// with its own wordmark + recovery search/links). Copy + toggles come from the
// admin 404 settings (Système → Redirections & 404).
export default async function NotFound() {
  // getNotFoundConfig is internally defensive (returns NOT_FOUND_DEFAULTS on any
  // failure), so it's the single source of truth — no inline fallback strings.
  const cfg = await getNotFoundConfig();
  return (
    <NotFoundScene
      title={cfg.title}
      message={cfg.message}
      showSearch={cfg.showSearch}
      showSuggestions={cfg.showSuggestions}
      logoUrl={cfg.logoUrl}
    />
  );
}
