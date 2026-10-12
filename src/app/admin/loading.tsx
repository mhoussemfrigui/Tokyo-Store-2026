/**
 * Admin loading shell — shown while the server component for an admin page
 * is fetching. Renders a row of greybox cards inside the admin layout so
 * the sidebar stays visible and there's no full-page flash.
 *
 * Keep this skeleton conservative — too detailed and the diff between
 * loading and loaded is jarring; too generic and it feels like nothing
 * is happening.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-48 rounded-lg bg-surface" />
        <div className="h-4 w-72 rounded bg-surface" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl border border-border bg-card" />
        ))}
      </div>
      <div className="h-64 rounded-3xl border border-border bg-card" />
    </div>
  );
}
