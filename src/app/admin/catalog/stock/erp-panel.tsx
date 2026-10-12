"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Loader2, Plug, Save } from "lucide-react";

import { FieldSection, ToggleField } from "@/components/admin/_components/setting-fields";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import { StockReadOnlyBanner } from "./stock-read-only-banner";
import { saveErpSettingsAction } from "@/lib/actions/stock-settings";
import { ERP_MODE_KEY, type ErpConfig, type ErpMode } from "@/lib/inventory/erp-config";
import { type ActionState } from "@/lib/actions/types";

const MODE_CARDS: Array<{ id: ErpMode; title: string; desc: string }> = [
  { id: "off", title: "Aucun ERP", desc: "La plateforme gère tout le stock. Aucune synchronisation externe (par défaut)." },
  {
    id: "platform",
    title: "Plateforme maître",
    desc: "La plateforme fait autorité. Les changements de stock sont POUSSÉS vers l'ERP (webhooks) ; l'ERP suit / reflète.",
  },
  {
    id: "erp",
    title: "ERP maître",
    desc: "L'ERP prend la main. Le stock est piloté par l'ERP ; la plateforme applique ses écritures via /api/stock.",
  },
  {
    id: "mixed",
    title: "Mixte",
    desc: "Configuration fine : choisissez indépendamment ce qui est poussé vers l'ERP et ce qui en est reçu.",
  },
];

/**
 * ERP tab of Catalogue → Stock. Sets the STOCK sync posture between the platform
 * and an external ERP (off / platform-maître / ERP-maître / mixte), plus the
 * mixed per-axis toggles + a transfer-notification toggle. Wired to the existing
 * external HTTP API (/api/stock) + outbound webhooks; the actual authority
 * enforcement lands with the Phase-2 sync paths. Read-only without stock:update.
 */
export function ErpPanel({ config, canManage }: { config: ErpConfig; canManage: boolean }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveErpSettingsAction,
    null,
  );
  const [mode, setMode] = useState<ErpMode>(config.mode);
  // On a successful save, re-read the server so the card header pill (derived
  // from the server `config.mode` prop) reflects the newly-saved mode instead of
  // staying stale — and matching the radio — until a manual reload. Mirrors
  // InventorySettingsCard. `mode` state already equals the saved value, so the
  // refresh doesn't fight it.
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <div className="space-y-6">
      {/* Honest posture disclaimer — the mode + axes are RECORDED but authority
          enforcement (who overwrites whom, gating pushes on the toggles below) is
          not yet wired; it lands with the Phase-2 sync paths. What IS live today:
          the external /api/stock and the delivery of stock.* / stock.transfer.*
          events to any endpoint registered under Webhooks. */}
      <AdminCallout tone="warning" title="Posture enregistrée — application en Phase 2">
        <p className="mt-1">
          Ce choix définit et enregistre la posture ERP, mais l&apos;
          <strong>application de l&apos;autorité</strong> (qui écrase qui, et le conditionnement des envois aux
          bascules ci-dessous) arrive avec les chemins de synchronisation (Phase 2). Aucun ERP n&apos;est
          connecté pour l&apos;instant : la plateforme reste maître.
        </p>
        <p className="mt-1">
          Déjà actif : l&apos;API externe <span className="font-mono">/api/stock</span> (lecture/écriture) et la
          livraison des évènements <span className="font-mono">stock.*</span> /{" "}
          <span className="font-mono">stock.transfer.*</span> à tout point d&apos;entrée enregistré sous{" "}
          <Link href="/admin/system/api" className="font-medium underline underline-offset-2">
            Clés API &amp; webhooks
          </Link>
          .
        </p>
      </AdminCallout>

      <form action={formAction} className="rounded-[28px] border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-6 py-5">
          <Plug className="h-5 w-5 shrink-0 text-primary" />
          <span className="text-[18px] font-black text-foreground">Liaison ERP</span>
          <span className="truncate text-[12px] text-muted-foreground">
            · {MODE_CARDS.find((m) => m.id === config.mode)?.title ?? "Aucun ERP"}
          </span>
        </div>

        <div className="p-6">
          {!canManage && <StockReadOnlyBanner className="mb-4" />}

          <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-6 border-0 p-0">
            <FieldSection
              title="Mode de synchronisation"
              description="Qui fait autorité sur le stock entre votre plateforme et un ERP externe. L'application concrète (qui écrase qui) s'active avec la synchronisation ; ce choix définit la posture et le câblage."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {MODE_CARDS.map((m) => {
                  const active = mode === m.id;
                  return (
                    <label
                      key={m.id}
                      className={`flex cursor-pointer flex-col gap-1 rounded-[16px] border-[1.5px] p-4 transition ${
                        active ? "border-primary bg-[var(--accent)]" : "border-input hover:bg-surface"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={ERP_MODE_KEY}
                          value={m.id}
                          checked={active}
                          onChange={() => setMode(m.id)}
                          className="h-4 w-4 accent-[var(--primary)]"
                        />
                        <span className="text-[14px] font-bold text-foreground">{m.title}</span>
                        {active && <Check className="ml-auto h-4 w-4 text-primary" />}
                      </span>
                      <span className="pl-6 text-[13px] leading-relaxed text-muted-foreground">{m.desc}</span>
                    </label>
                  );
                })}
              </div>
            </FieldSection>

            {/* Mixed axes — only meaningful for the "mixte" mode (harmless otherwise;
                the resolver ignores them for the presets). */}
            {mode === "mixed" && (
              <FieldSection
                title="Axes (mixte)"
                description="Activez indépendamment chaque direction de synchronisation du stock."
              >
                <ToggleField
                  name="erp.push_stock"
                  label="Pousser le stock vers l'ERP"
                  description="Les changements de stock de la plateforme sont envoyés à l'ERP (webhooks sortants)."
                  defaultChecked={config.pushStock}
                />
                <ToggleField
                  name="erp.pull_stock"
                  label="Recevoir le stock de l'ERP"
                  description="L'ERP peut écrire le stock via /api/stock et fait alors autorité sur ces quantités."
                  defaultChecked={config.pullStock}
                />
              </FieldSection>
            )}

            <FieldSection
              title="Transferts"
              description="Notifier l'ERP des mouvements internes entre emplacements."
            >
              <ToggleField
                name="erp.push_transfers"
                label="Notifier l'ERP des transferts terminés"
                description="Posture Phase 2 (enregistrée). Aujourd'hui, l'évènement stock.transfer.completed est déjà émis à chaque réception et livré à tout webhook abonné — indépendamment de cette bascule, qui conditionnera l'envoi une fois la synchronisation active."
                defaultChecked={config.pushTransfers}
              />
            </FieldSection>

            {/* Warranty / SAV axis — mode-independent (like transfers): the stock
                mode above governs stock only, never claim authority. */}
            <FieldSection
              title="Garanties (SAV)"
              description="Synchroniser les réclamations de garantie (RMA) avec l'ERP / l'atelier de réparation."
            >
              <ToggleField
                name="erp.push_warranty"
                label="Pousser les réclamations vers l'ERP"
                description="Posture Phase 2 (enregistrée). Aujourd'hui les évènements warranty.claim.created / .updated / .resolved sont déjà livrés à tout webhook abonné à chaque ouverture, mise à jour et clôture — indépendamment de cette bascule, qui conditionnera l'envoi une fois la synchronisation active. Pour ne PAS recevoir ces évènements, désabonnez l'endpoint du domaine warranty.claim.*."
                defaultChecked={config.pushWarranty}
              />
              <ToggleField
                name="erp.pull_warranty"
                label="Recevoir les réclamations de l'ERP"
                description="Posture Phase 2 (enregistrée). Aujourd'hui l'ERP peut déjà faire évoluer le statut d'une réclamation via PATCH /api/warranty-claims/[id] (par référence externe) dès qu'une clé porte la portée warranty:write — indépendamment de cette bascule, qui conditionnera l'écriture une fois la synchronisation active."
                defaultChecked={config.pullWarranty}
              />
            </FieldSection>
          </fieldset>

          {state && !state.ok && <p className="mt-4 text-[14px] text-destructive">{state.message}</p>}
          {state?.ok && <p className="mt-4 text-[14px] text-[#15803d]">{state.message}</p>}

          {canManage && (
            <div className="mt-6 flex justify-end">
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Enregistrer
              </button>
            </div>
          )}
        </div>
      </form>

      {/* Connection reference — the endpoints + where the ERP's key / webhooks live. */}
      <div className="rounded-[28px] border border-border bg-card p-6">
        <h3 className="text-[18px] font-black text-foreground">Connexion & points d&apos;entrée</h3>
        <AdminNote className="mt-1">
          L&apos;ERP lit et écrit le stock via l&apos;API HTTP externe, par référence produit / variante
          (productId, référence externe, SKU ou GTIN).
        </AdminNote>
        <dl className="mt-4 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="rounded-[6px] bg-[#f6f2ed] px-1.5 py-0.5 font-mono font-bold text-foreground">GET / PUT</dt>
            <dd className="font-mono text-muted-foreground">/api/products</dd>
            <dd className="text-muted-foreground">— lire / créer / mettre à jour une fiche produit (upsert idempotent par référence externe, SKU ou GTIN).</dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="rounded-[6px] bg-[#f6f2ed] px-1.5 py-0.5 font-mono font-bold text-foreground">GET / PATCH</dt>
            <dd className="font-mono text-muted-foreground">/api/stock</dd>
            <dd className="text-muted-foreground">
              — lire / ajuster le stock TOTAL (delta ou valeur absolue), ou le stock d&apos;UN emplacement
              précis avec <span className="font-mono">?location=&lt;code&gt;</span> (le dépôt central ou une
              boutique, par son code ERP) — en mode « par emplacement ».
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="rounded-[6px] bg-[#f6f2ed] px-1.5 py-0.5 font-mono font-bold text-foreground">GET</dt>
            <dd className="font-mono text-muted-foreground">/api/stock/movements</dd>
            <dd className="text-muted-foreground">— journal des mouvements (réconciliation).</dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="rounded-[6px] bg-[#f6f2ed] px-1.5 py-0.5 font-mono font-bold text-foreground">GET / POST</dt>
            <dd className="font-mono text-muted-foreground">/api/warranty-claims</dd>
            <dd className="text-muted-foreground">— lister / ouvrir des réclamations de garantie (SAV).</dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="rounded-[6px] bg-[#f6f2ed] px-1.5 py-0.5 font-mono font-bold text-foreground">GET / PATCH</dt>
            <dd className="font-mono text-muted-foreground">/api/warranty-claims/[id]</dd>
            <dd className="text-muted-foreground">— suivre / faire évoluer le statut d&apos;une réclamation.</dd>
          </div>
        </dl>
        <Link
          href="/admin/system/api"
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-4 py-2 text-xs font-bold text-foreground transition hover:bg-surface"
        >
          Clés API & webhooks ERP
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
