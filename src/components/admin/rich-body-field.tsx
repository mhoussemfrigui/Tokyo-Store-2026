"use client";

import { useRef, useState } from "react";
import { ImagePlus, Images, Loader2 } from "lucide-react";

import { PickerDialog } from "@/components/admin/media-picker";

/**
 * HTML body textarea with an "insert image" action. The inserted image is
 * pulled into the médiathèque first (secure URL ingestion → webp/avif) and the
 * resulting /cdn URL is spliced into the body as an <img> tag at the cursor.
 * So inline article images are optimised + same-origin, never hot-linked.
 *
 * Uncontrolled (defaultValue + name) so it drops into the existing form-data
 * submission with no extra wiring.
 */
export function RichBodyField({
  name,
  label,
  defaultValue,
  rows = 12,
  helper,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  rows?: number;
  helper?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  const insertAtCursor = (snippet: string) => {
    const ta = ref.current;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(end);
    const pos = start + snippet.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  };

  const insertFromUrl = async () => {
    const url = window.prompt("URL de l'image à insérer (elle sera importée dans la médiathèque) :")?.trim();
    if (!url) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/media/import-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, scope: "cms" }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setErr(body.error ?? `Échec de l'import (HTTP ${res.status})`);
        return;
      }
      insertAtCursor(`\n<img src="${body.url}" alt="" />\n`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de l'import de l'image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[11px] font-medium text-foreground transition hover:bg-surface"
          >
            <Images className="h-3.5 w-3.5" />
            Médiathèque
          </button>
          <button
            type="button"
            onClick={insertFromUrl}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[11px] font-medium text-foreground transition hover:bg-surface disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            URL
          </button>
        </div>
      </div>
      <textarea
        ref={ref}
        name={name}
        defaultValue={defaultValue ?? ""}
        rows={rows}
        spellCheck={false}
        className="w-full rounded-2xl border border-border bg-background p-3 font-mono text-[12px] leading-relaxed focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
      {helper && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}

      {browseOpen && (
        <PickerDialog
          multi={false}
          scope="cms"
          selectedIds={[]}
          onClose={() => setBrowseOpen(false)}
          onPick={(item) => {
            insertAtCursor(`\n<img src="${item.url}" alt="" />\n`);
            setBrowseOpen(false);
          }}
        />
      )}
    </div>
  );
}
