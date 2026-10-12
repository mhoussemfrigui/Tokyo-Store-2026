import { ArrowRight, ArrowUpRight, Building2, Clock, HelpCircle, Mail, MapPin, MessageCircle, Phone, Store } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  CONTACT_CHANNEL_LABELS,
  telHref,
  whatsappHref,
  type ContactChannel,
  type ContactChannelKey,
  type PageBlock,
} from "@/lib/pages/page-blocks";
import type { PageSiteContact } from "@/lib/pages/page-blocks-data";
import { BODY, Eyebrow, PageSection, SmartLink, Title } from "./kit";

/** `custom` = the operator's own label (blank → the strip uses a short default). */
type Row = { key: ContactChannelKey; label: string; custom: string; value: string; note: string; href: string; external: boolean };

const ICON: Record<ContactChannelKey, LucideIcon> = {
  phone: Phone,
  whatsapp: MessageCircle,
  email: Mail,
  stores: Store,
  help: HelpCircle,
};

/** Resolve each enabled channel against the « Identité & contact » settings. A channel
 *  whose setting is unset (e.g. no WhatsApp number) is simply not shown. */
export function resolveChannels(channels: ContactChannel[], site: PageSiteContact): Row[] {
  const rows: Row[] = [];
  for (const ch of channels) {
    if (!ch.enabled) continue;
    const label = ch.label || CONTACT_CHANNEL_LABELS[ch.key];
    switch (ch.key) {
      case "phone": {
        const href = telHref(site.phone);
        if (href) rows.push({ key: ch.key, label, custom: ch.label, value: site.phone, note: ch.note || site.hours, href, external: false });
        break;
      }
      case "whatsapp": {
        const href = whatsappHref(site.whatsapp);
        if (href)
          rows.push({ key: ch.key, label, custom: ch.label, value: site.whatsapp, note: ch.note || "Écrivez-nous en direct", href, external: true });
        break;
      }
      case "email": {
        if (site.email)
          rows.push({ key: ch.key, label, custom: ch.label, value: site.email, note: ch.note, href: `mailto:${site.email}`, external: false });
        break;
      }
      case "stores":
        rows.push({ key: ch.key, label, custom: ch.label, value: ch.note || "Adresses & horaires", note: "", href: ch.href || "/apropos#boutiques", external: false });
        break;
      case "help":
        rows.push({ key: ch.key, label, custom: ch.label, value: ch.note || "Questions fréquentes", note: "", href: ch.href || "/aide", external: false });
        break;
    }
  }
  return rows;
}

export function ContactChannelsBlock({
  block,
  site,
  level,
}: {
  block: PageBlock;
  site: PageSiteContact;
  level: 1 | 2;
}) {
  const c = block.config;
  const h = c.header;
  const rows = resolveChannels(c.channels ?? [], site);
  if (rows.length === 0 && !h?.title) return null;
  const p = c.presentation;

  if (c.layout === "strip") {
    return (
      <PageSection presentation={p} anchor={c.anchor}>
        <div className="flex flex-col gap-7 rounded-[1.75rem] border border-border/60 bg-card/70 px-6 py-8 sm:px-10 sm:py-10 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 max-w-xl">
            {h?.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
            <Title as={level === 1 ? "h1" : "h2"} text={h?.title} accent={c.accent} className="text-2xl leading-tight md:text-3xl" />
            {h?.subtitle && <p className={cn(BODY, "mt-3")}>{h.subtitle}</p>}
          </div>
          {rows.length > 0 && (
            <div className="flex flex-wrap gap-2.5">
              {rows.map((r, i) => {
                const Icon = ICON[r.key];
                // The operator's own label wins; otherwise the phone button shows the number
                // itself (useful at a glance / on mobile) and e-mail a short verb.
                const text = r.custom || (r.key === "phone" ? r.value : r.key === "email" ? "Nous écrire" : r.label);
                return (
                  <SmartLink
                    key={r.key}
                    href={r.href}
                    // Accessible name STARTS with the visible text (WCAG 2.5.3 Label in Name).
                    aria-label={text === r.value ? text : `${text} — ${r.value}`}
                    className={buttonVariants({ variant: i === 0 ? "primary" : "secondary", size: "md" })}
                  >
                    <span className="btn__label">
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden /> {text}
                    </span>
                  </SmartLink>
                );
              })}
            </div>
          )}
        </div>
      </PageSection>
    );
  }

  // « Conciergerie » — the page opener: a large two-tone title on the left, a contact
  // DESK on the right listing the live channels (one row each, value + helper line).
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <PageSection presentation={p} anchor={c.anchor} pad={level === 1 ? "hero" : undefined}>
      <div className="grid gap-y-12 lg:grid-cols-12 lg:items-center lg:gap-x-12">
        <div className="tk-fade-in-up min-w-0 lg:col-span-7">
          {h?.eyebrow && <Eyebrow>{h.eyebrow}</Eyebrow>}
          <Title as={Tag} text={h?.title} accent={c.accent} className="text-4xl leading-[1.05] sm:text-5xl lg:text-[3.6rem]" />
          {h?.subtitle && <p className={cn(BODY, "mt-6 max-w-xl")}>{h.subtitle}</p>}
          {c.showMeta !== false &&
            (site.hours || site.address || (site.hqAddressPublic && site.hqAddress)) && (
            <ul className="mt-8 space-y-2.5 font-body text-sm text-foreground/80">
              {site.hours && (
                <li className="flex items-center gap-2.5">
                  <Clock className="h-4 w-4 text-gold" strokeWidth={1.6} aria-hidden /> {site.hours}
                </li>
              )}
              {site.address && (
                <li className="flex items-center gap-2.5">
                  <MapPin className="h-4 w-4 text-gold" strokeWidth={1.6} aria-hidden /> {site.address}
                </li>
              )}
              {/* Central HQ / registered address — shown only when the admin enabled
                  its front-end visibility (business.hq_address_public). */}
              {site.hqAddressPublic && site.hqAddress && (
                <li className="flex items-center gap-2.5">
                  <Building2 className="h-4 w-4 text-gold" strokeWidth={1.6} aria-hidden /> Siège social : {site.hqAddress}
                </li>
              )}
            </ul>
          )}
        </div>
        {rows.length > 0 && (
          <div className="min-w-0 lg:col-span-5">
            <ul className="divide-y divide-border/60 overflow-hidden rounded-[1.75rem] border border-border/60 bg-card shadow-[0_34px_70px_-48px_rgba(43,40,37,0.5)]">
              {rows.map((r) => {
                const Icon = ICON[r.key];
                const Arrow = r.external ? ArrowUpRight : ArrowRight;
                return (
                  <li key={r.key}>
                    <SmartLink
                      href={r.href}
                      className="group flex items-center gap-4 px-5 py-5 transition-colors duration-300 hover:bg-accent/25 sm:px-7"
                    >
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent/45 text-olive">
                        <Icon className="h-[1.1rem] w-[1.1rem]" strokeWidth={1.6} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-body text-[0.65rem] uppercase tracking-[0.24em] text-muted-foreground">
                          {r.label}
                        </span>
                        <span className="block font-serif text-base text-foreground [overflow-wrap:anywhere] sm:text-xl">{r.value}</span>
                        {r.note && <span className="block font-body text-xs text-muted-foreground">{r.note}</span>}
                      </span>
                      <Arrow
                        className="h-4 w-4 shrink-0 text-muted-foreground transition-[translate,color] duration-300 group-hover:translate-x-0.5 group-hover:text-olive"
                        aria-hidden
                      />
                    </SmartLink>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </PageSection>
  );
}
