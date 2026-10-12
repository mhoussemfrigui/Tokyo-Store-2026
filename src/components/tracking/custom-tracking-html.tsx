"use client";

import { useEffect, useRef } from "react";

import { useConsent } from "@/components/consent/consent-provider";

/**
 * Injects owner-supplied raw HTML from Suivi & Analytics → « Code personnalisé »
 * (head/body snippets for tags the dedicated GTM/GA4/Pixel fields don't cover —
 * e.g. TikTok, Hotjar; their hosts must be CSP-allow-listed — see headers.ts /
 * CSP_EXTRA_HOSTS). <script> set via innerHTML does NOT execute, so we recreate
 * each script node so the browser runs it.
 *
 * Consent-gated — injected only once `isAllowed` reports analytics OR marketing
 * granted (NOT released early by Consent Mode "advanced"). Google Consent Mode
 * can't govern arbitrary third-party snippets, so they wait for an affirmative
 * decision. EXCEPTION: under « Bypass / tout suivre » (`tracking.bypass_consent`)
 * or a disabled banner the consent provider grants everything, so the snippet
 * then runs for EVERY visitor without a choice. The HTML is OWNER-ONLY admin
 * input — writable only by a `*` holder (TRACKING_SCRIPT_KEYS, enforced in
 * src/lib/actions/analytics.ts), since it runs with the session of any staff
 * member browsing the shop — and is NEVER exposed via the public content API.
 *
 * Injected once; NOT auto-removed if consent is later withdrawn (you can't
 * reliably un-load an arbitrary snippet) — the admin copy warns about this.
 */
export function CustomTrackingHtml({ html }: { html: string }) {
  const consent = useConsent();
  const ref = useRef<HTMLDivElement>(null);
  const injected = useRef(false);
  const allowed = Boolean(consent?.isAllowed("analytics") || consent?.isAllowed("marketing"));

  useEffect(() => {
    if (!html || !allowed || injected.current) return;
    const container = ref.current;
    if (!container) return;
    injected.current = true;
    container.innerHTML = html;
    for (const old of Array.from(container.querySelectorAll("script"))) {
      const s = document.createElement("script");
      for (const attr of Array.from(old.attributes)) s.setAttribute(attr.name, attr.value);
      s.text = old.textContent ?? "";
      old.replaceWith(s);
    }
  }, [html, allowed]);

  if (!html) return null;
  return <div ref={ref} suppressHydrationWarning />;
}
