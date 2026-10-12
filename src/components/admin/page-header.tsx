import type { ReactNode } from "react";

/**
 * Shared admin page header — the page DESCRIPTION + right-aligned action slot.
 *
 * The admin shell's topbar already renders the page TITLE (from the active nav
 * item), so a second big `<h1>` in the content was a visible duplicate on every
 * list/settings page. The title now lives only in the topbar; this header keeps
 * the title for screen-readers (`sr-only`) and surfaces the description at the top
 * of the content — directly under the topbar title — plus any action buttons.
 * When a page passes neither a description nor an action it renders nothing (so
 * title-only pages don't leave an empty gap under the topbar).
 */
export function AdminPageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  if (!description && !action) return null;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
      <div className="min-w-0 flex-1">
        <h1 className="sr-only">{title}</h1>
        {description && (
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
