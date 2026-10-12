/**
 * Tiny Mustache-style renderer for email templates.
 *
 * Replaces `{{ key }}` / `{{key}}` with values from a variables map. Missing
 * variables become an empty string. No conditionals or loops — keep templates
 * declarative and do any logic before rendering.
 *
 * SECURITY: scalar variable values are inserted *as-is* here, so the caller
 * (`dispatchEmail`) MUST pre-escape any untrusted scalar (customer name, order
 * number, …) via `escapeHtml`. Variables that are intentionally HTML (e.g. a
 * pre-built `items_html` table whose cells were escaped when built) are passed
 * through unescaped on purpose. Template bodies themselves are authored by code
 * or trusted admins.
 */

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function renderTemplate(
  template: string,
  variables: Record<string, unknown> = {},
): string {
  return template.replace(VAR_RE, (_, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) return "";
    return String(value);
  });
}

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Defence-in-depth strip for admin-authored override HTML at SAVE time. Admins
 * are trusted (system_mail:update gates the editor, plus the `*` wildcard for
 * the account-security templates), and email clients ignore
 * scripts anyway, but we remove obvious script/handler vectors so a stored
 * override can never execute in the admin preview or a permissive webmail.
 * Deliberately light — it preserves tables + inline styles that emails need.
 */
export function stripUnsafeEmailHtml(html: string): string {
  return html
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}
