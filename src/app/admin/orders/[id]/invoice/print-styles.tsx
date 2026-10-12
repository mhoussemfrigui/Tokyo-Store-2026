/**
 * Print reset for the standalone order documents (facture / avoir / bon de
 * livraison). `@page { margin: 0 }` is the one lever that makes Chromium drop
 * its default header/footer bands — the date, the `document.title`, and the
 * page URL the operator complained about. With zero page margin the document
 * supplies its OWN padding (the `print:p-…` on each page wrapper), so nothing
 * touches the sheet edge.
 *
 * It's a global at-rule, but it only exists in the DOM while one of these
 * document pages is mounted (they render bare, outside the admin shell — see
 * AdminShell's print-route passthrough), so it never leaks into other prints.
 */
export function PrintStyles() {
  return (
    <style>
      {"@media print{@page{margin:0}html,body{background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}"}
    </style>
  );
}
