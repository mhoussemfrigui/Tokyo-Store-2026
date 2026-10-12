"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bold,
  Code,
  Code2,
  Eye,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  Quote,
} from "lucide-react";

import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";

/**
 * Shared admin rich-text (HTML) editor — used by the product editor AND the
 * category editor so they share ONE editing + sanitising pipeline (and can
 * never drift). Provides:
 *   - a small formatting toolbar that wraps/inserts the ALLOWED tags at the
 *     caret (strong, em, h2/h3, ul/li, a, blockquote, code),
 *   - a Code / Aperçu (preview) toggle so admins see the rendered output,
 *   - an optional one-click "Générer (IA)" button (per feature/task),
 *   - a placeholder formatted as HTML so admins immediately see the shape.
 *
 * Server-side rendering uses `sanitizeRichHtml` (DOMPurify html profile + an
 * /cdn-only <img src> guard) — the IDENTICAL recipe the storefront uses on the
 * PDP / category page — so what you preview is what renders (modulo the prose
 * typography wrapper applied in the page).
 *
 * The textarea stays mounted across mode switches so the form's FormData always
 * captures the value — switching to "Aperçu" doesn't drop pending edits or break
 * server actions.
 */
export function RichTextField({
  name,
  rows,
  defaultValue,
  placeholder,
  label,
  helper,
  onChange,
  submit = true,
}: {
  name: string;
  rows: number;
  defaultValue?: string | null;
  /** When false the textarea is NOT submitted as a FormData field (omits `name`) — for a
   *  CONTROLLED host (the block composer) that already carries the value in its own JSON, so
   *  the HTML isn't POSTed twice. The textarea keeps its id/value for display + a11y. */
  submit?: boolean;
  /** Optional CONTROLLED sink: fires with the current HTML on every edit (typing or
   *  toolbar). Lets a JSON-state host (the block composer) keep the value without relying
   *  on the FormData `name`. The internal textarea stays the display source of truth. */
  onChange?: (html: string) => void;
  placeholder?: string;
  /** Optional visible label, programmatically associated with the textarea (a11y). */
  label?: string;
  /** Optional helper text rendered under the label. */
  helper?: string;
}) {
  const id = `f-${name}`;
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [mode, setMode] = useState<"code" | "preview">("code");
  // Controlled sink: mirror the value to the host on every change (from any source).
  useEffect(() => {
    onChange?.(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // The textarea remains the single source of truth for FormData; the toolbar
  // only edits its `value` via the same setState the typing uses. We grab the
  // live element by id at click time (inside handlers, never during render).
  const getTextarea = () =>
    typeof document === "undefined"
      ? null
      : (document.getElementById(id) as HTMLTextAreaElement | null);

  const safePreview = useMemo(() => (value ? sanitizeRichHtml(value) : ""), [value]);

  /**
   * Apply a formatting action at the current selection. `before`/`after` wrap
   * the selected text (or are inserted at the caret when nothing is selected).
   * We mutate the controlled `value` then restore focus + a sensible selection.
   * Operates ONLY on the textarea string — no contentEditable, so the `name=`
   * textarea stays the FormData source of truth untouched.
   */
  const surround = (before: string, after: string, placeholderText = "") => {
    const ta = getTextarea();
    const start = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    const selected = value.slice(start, end) || placeholderText;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      const el = getTextarea();
      if (!el) return;
      el.focus();
      const selStart = start + before.length;
      el.setSelectionRange(selStart, selStart + selected.length);
    });
  };

  const insertLink = () => {
    const url = window.prompt("URL du lien (https://…)", "https://");
    if (!url) return;
    surround(`<a href="${url}">`, "</a>", "texte du lien");
  };

  const insertList = () => {
    const ta = getTextarea();
    const start = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    const selected = value.slice(start, end);
    const lines = (selected || "Premier point\nSecond point").split("\n");
    const block = `<ul>\n${lines.map((l) => `  <li>${l}</li>`).join("\n")}\n</ul>`;
    const next = value.slice(0, start) + block + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      const el = getTextarea();
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, start + block.length);
    });
  };

  const isPreview = mode === "preview";

  const toolbarButtons: {
    label: string;
    title: string;
    icon: typeof Bold;
    onClick: () => void;
  }[] = [
    { label: "Gras", title: "Gras (strong)", icon: Bold, onClick: () => surround("<strong>", "</strong>", "texte en gras") },
    { label: "Italique", title: "Italique (em)", icon: Italic, onClick: () => surround("<em>", "</em>", "texte en italique") },
    { label: "Titre", title: "Titre de section (h2)", icon: Heading2, onClick: () => surround("<h2>", "</h2>", "Titre") },
    { label: "Sous-titre", title: "Sous-titre (h3)", icon: Heading3, onClick: () => surround("<h3>", "</h3>", "Sous-titre") },
    { label: "Liste", title: "Liste à puces (ul/li)", icon: List, onClick: insertList },
    { label: "Lien", title: "Lien (a href)", icon: Link2, onClick: insertLink },
    { label: "Citation", title: "Citation (blockquote)", icon: Quote, onClick: () => surround("<blockquote>", "</blockquote>", "Citation") },
    { label: "Code", title: "Code en ligne (code)", icon: Code, onClick: () => surround("<code>", "</code>", "code") },
  ];

  return (
    <div>
      {(label || helper) && (
        <div className="mb-2">
          {label && (
            <label
              htmlFor={id}
              className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {label}
            </label>
          )}
          {helper && <p className="mt-0.5 text-[10px] text-muted-foreground">{helper}</p>}
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1"
            role="tablist"
            aria-label="Mode d'édition"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "code"}
              onClick={() => setMode("code")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition ${
                mode === "code"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Code2 className="h-3.5 w-3.5" /> Code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "preview"}
              onClick={() => setMode("preview")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition ${
                mode === "preview"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Eye className="h-3.5 w-3.5" /> Aperçu
            </button>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
          HTML autorisé&nbsp;: paragraphes, gras, italique, listes, liens, titres
          (h2–h4), citations, code. Le reste est retiré à l&apos;affichage.
        </span>
      </div>

      {/* Formatting toolbar — inserts/wraps the allowed tags at the cursor.
          Disabled in preview mode (editing happens in Code). */}
      <div
        className="mb-2 flex flex-wrap items-center gap-1 rounded-2xl border border-border bg-surface/40 p-1.5"
        role="toolbar"
        aria-label="Mise en forme"
      >
        {toolbarButtons.map((b) => {
          const Icon = b.icon;
          return (
            <button
              key={b.label}
              type="button"
              onClick={b.onClick}
              disabled={isPreview}
              title={b.title}
              aria-label={b.title}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{b.label}</span>
            </button>
          );
        })}
      </div>

      {/* The textarea stays in the DOM in both modes so FormData captures the
          value regardless of which mode is shown at submit. In preview it's
          `sr-only` (kept focusable for a11y) and the sanitised HTML renders. */}
      <textarea
        id={id}
        name={submit ? name : undefined}
        rows={rows}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={
          mode === "code"
            ? "block w-full rounded-2xl border border-border bg-background p-3 font-mono text-[13px] leading-relaxed focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            : "sr-only"
        }
      />

      {mode === "preview" && (
        <div className="rounded-2xl border border-border bg-card p-5">
          {safePreview ? (
            <div
              className="prose prose-sm max-w-none text-foreground prose-headings:font-display prose-headings:font-semibold prose-headings:text-foreground prose-strong:text-foreground prose-a:text-primary prose-li:my-0.5"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: safePreview }}
            />
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Aucun contenu à prévisualiser. Repassez sur l&apos;onglet
              «&nbsp;Code&nbsp;» pour saisir du HTML.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
