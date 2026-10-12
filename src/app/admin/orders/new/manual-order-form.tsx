"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2, ShoppingCart } from "lucide-react";

import { AdminSearch } from "@/components/admin/_components/filter-bar";
import { SelectField } from "@/components/ui/select-field";
import { formatMoneyExact } from "@/lib/price";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import { ORDER_SOURCES } from "@/lib/order/order-source";
import {
  searchProductsForOrderAction,
  createManualOrderAction,
  type ManualOrderProductHit,
} from "@/lib/actions/manual-order";

type Line = {
  key: string;
  productId: string;
  name: string;
  variantId: string;
  variantLabel: string | null;
  quantity: number;
  priceCents: number;
};

const input =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";
const labelCls = "text-[13px] font-bold text-foreground";

export function ManualOrderForm({
  agents,
  pickups,
  coupons,
  canViewOrders,
}: {
  agents: Array<{ id: string; name: string }>;
  pickups: Array<{ id: string; name: string; kind: string }>;
  /** Live code-coupons for the « Code promo » picker ({code, label}). */
  coupons: Array<{ code: string; label: string }>;
  /** orders:view — the created order's detail page needs it. Without it (a
   *  delegated « Nouvelle commande » role) the form confirms IN PLACE instead of
   *  redirecting to a 404, which would read as a failure and invite a duplicate
   *  re-entry (second order + second stock decrement). */
  canViewOrders: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // In-place confirmation (only when !canViewOrders) — the action's message
  // carries the order number; `warning` = created but NOT marked paid.
  const [created, setCreated] = useState<{ message: string; warning: boolean } | null>(null);
  // Per-field client validation errors, so a missing name/address/city (or a
  // malformed email) points AT the offending field instead of one generic banner.
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  // ── Line items
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ManualOrderProductHit[]>([]);
  const [searching, startSearch] = useTransition();

  // ── Customer + address
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState(""); // marketing origin (Facebook / phone …); "" = non précisée
  const [attach, setAttach] = useState(true);
  const [fullName, setFullName] = useState("");
  const [street1, setStreet1] = useState("");
  const [street2, setStreet2] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postal, setPostal] = useState("");

  // ── Delivery + payment
  const [deliveryMethod, setDeliveryMethod] = useState("home_delivery");
  const [agentId, setAgentId] = useState("");
  const [pickupId, setPickupId] = useState("");
  const [channel, setChannel] = useState("cash");
  const [reference, setReference] = useState("");
  const [promo, setPromo] = useState("");

  const subtotalCents = lines.reduce((acc, l) => acc + l.priceCents * l.quantity, 0);

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    startSearch(async () => {
      const res = await searchProductsForOrderAction(q).catch(() => []);
      setHits(res);
    });
  };

  const addLine = (hit: ManualOrderProductHit, variantId: string) => {
    const variant = hit.variants.find((v) => v.id === variantId);
    setLines((s) => [
      ...s,
      {
        key: `${hit.id}_${variantId}_${s.length}`,
        productId: hit.id,
        name: hit.name,
        variantId,
        variantLabel: variant?.label ?? null,
        quantity: 1,
        priceCents: variant?.priceCents ?? hit.priceCents,
      },
    ]);
    setQuery("");
    setHits([]);
  };

  const submit = () =>
    start(async () => {
      if (lines.length === 0) {
        setMsg({ ok: false, text: "Ajoutez au moins un article." });
        return;
      }
      // Client-side guard mirroring the server schema (shipping.fullName /
      // streetLine1 / city required, email must be valid-or-empty). Directs the
      // operator to the exact field instead of the flat "Champs invalides" banner.
      const errs: Record<string, string> = {};
      if (!fullName.trim()) errs.fullName = "Nom requis.";
      if (!street1.trim()) errs.street1 = "Adresse requise.";
      if (!city.trim()) errs.city = "Ville requise.";
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        errs.email = "E-mail invalide.";
      setFieldErr(errs);
      if (Object.keys(errs).length > 0) {
        setMsg({ ok: false, text: "Complétez les champs surlignés (client / adresse)." });
        return;
      }
      const res = await createManualOrderAction({
        attachByEmail: attach,
        contactEmail: email.trim(),
        contactPhone: phone.trim() || undefined,
        shipping: {
          fullName: fullName.trim(),
          streetLine1: street1.trim(),
          streetLine2: street2.trim() || undefined,
          city: city.trim(),
          region: region.trim() || undefined,
          postalCode: postal.trim() || undefined,
          phone: phone.trim() || undefined,
        },
        lines: lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId || undefined,
          quantity: l.quantity,
        })),
        deliveryMethod: deliveryMethod as "home_delivery" | "drive_by_pickup" | "in_store",
        deliveryAgentId: deliveryMethod === "home_delivery" && agentId ? agentId : undefined,
        pickupLocationId: deliveryMethod !== "home_delivery" && pickupId ? pickupId : undefined,
        promotionCode: promo.trim() || undefined,
        paymentChannel: channel as "cash" | "bank_transfer" | "cod",
        paymentReference: reference.trim() || undefined,
        source: source || undefined,
      });
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Créée." : "Erreur.") });
      if (res.ok && res.orderId) {
        if (canViewOrders) router.push(`/admin/orders/${res.orderId}`);
        else setCreated({ message: res.message ?? "Commande créée.", warning: Boolean(res.warning) });
      }
    });

  // « Nouvelle commande » after an in-place confirmation: back to a blank form.
  const resetForm = () => {
    setLines([]);
    setQuery("");
    setHits([]);
    setEmail("");
    setPhone("");
    setAttach(true);
    setFullName("");
    setStreet1("");
    setStreet2("");
    setCity("");
    setRegion("");
    setPostal("");
    setDeliveryMethod("home_delivery");
    setAgentId("");
    setPickupId("");
    setChannel("cash");
    setReference("");
    setPromo("");
    setFieldErr({});
    setMsg(null);
    setCreated(null);
  };

  if (created) {
    return (
      <div className="rounded-[28px] border border-border bg-card p-10 text-center">
        {created.warning ? (
          <AlertTriangle className="mx-auto h-12 w-12 text-[#b45309]" strokeWidth={1.4} />
        ) : (
          <CheckCircle2 className="mx-auto h-12 w-12 text-[#15803d]" strokeWidth={1.4} />
        )}
        <h2 className={`mt-4 text-xl font-black tracking-[-0.02em] ${created.warning ? "text-[#b45309]" : "text-foreground"}`}>
          {created.message}
        </h2>
        {created.warning && (
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Vous n&apos;avez pas accès à la fiche commande : transmettez ce numéro à un responsable
            des commandes pour enregistrer le règlement.
          </p>
        )}
        <button
          type="button"
          onClick={resetForm}
          className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" /> Nouvelle commande
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      {/* Left: lines + customer + address */}
      <div className="space-y-4">
        {/* Line items */}
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
            <ShoppingCart className="h-4 w-4" /> Articles
          </h2>
          <div className="relative">
            {/* Substring product search (name / SKU). Enter is a no-op (the list
                updates live via onChange). */}
            <div className="flex items-center gap-2">
              <AdminSearch
                value={query}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="Rechercher un produit (nom, SKU)…"
                className="flex-1"
              />
              {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
            </div>
            {hits.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-[14px] border border-border bg-card shadow-lg">
                {hits.map((hit) => (
                  <ProductHitRow key={hit.id} hit={hit} onAdd={addLine} />
                ))}
              </div>
            )}
          </div>

          {lines.length === 0 ? (
            <p className="mt-3 rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[12px] text-muted-foreground">
              Aucun article. Recherchez un produit ci-dessus pour l&apos;ajouter.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {lines.map((l, idx) => (
                <li key={l.key} className="flex items-center gap-2 rounded-[14px] border border-input bg-[#fbf9f8] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{l.name}</p>
                    {l.variantLabel && <p className="text-[11px] text-muted-foreground">{l.variantLabel}</p>}
                    <p className="text-[11px] text-muted-foreground">{formatMoneyExact(l.priceCents)} / unité</p>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((s) =>
                        s.map((x, i) => (i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)),
                      )
                    }
                    className="h-9 w-16 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-sm tabular-nums"
                    aria-label={`Quantité ${l.name}`}
                  />
                  <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {formatMoneyExact(l.priceCents * l.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLines((s) => s.filter((_, i) => i !== idx))}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-input text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                    aria-label="Retirer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Customer */}
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Client</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="E-mail" error={fieldErr.email}><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" maxLength={ORDER_FIELD_MAX.email} className={input} placeholder="client@exemple.tn" /></Field>
            <Field label="Téléphone"><input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={ORDER_FIELD_MAX.phone} className={input} placeholder="+216 …" /></Field>
          </div>
          <div className="mt-2">
            <Field label="Source de la commande">
              <SelectField
                ariaLabel="Source de la commande"
                value={source}
                onChange={setSource}
                options={[
                  { value: "", label: "— Non précisée —" },
                  ...ORDER_SOURCES.map((s) => ({ value: s.value, label: s.label })),
                ]}
              />
            </Field>
            <p className="mt-1 text-[10px] text-muted-foreground">
              D&apos;où provient la commande (Facebook, Instagram, téléphone…) — pour le suivi des canaux d&apos;acquisition.
            </p>
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
            Attribuer au compte de ce client si un compte existe avec cet e-mail
          </label>
        </section>

        {/* Shipping address */}
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Adresse de livraison</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nom complet" required error={fieldErr.fullName}><input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={ORDER_FIELD_MAX.name} className={input} /></Field>
            <Field label="Adresse" required error={fieldErr.street1}><input value={street1} onChange={(e) => setStreet1(e.target.value)} maxLength={ORDER_FIELD_MAX.addressLine} className={input} /></Field>
            <Field label="Complément"><input value={street2} onChange={(e) => setStreet2(e.target.value)} maxLength={ORDER_FIELD_MAX.addressLine} className={input} /></Field>
            <Field label="Ville" required error={fieldErr.city}><input value={city} onChange={(e) => setCity(e.target.value)} maxLength={ORDER_FIELD_MAX.place} className={input} /></Field>
            <Field label="Gouvernorat"><input value={region} onChange={(e) => setRegion(e.target.value)} maxLength={ORDER_FIELD_MAX.place} className={input} placeholder="Tunis, Sfax…" /></Field>
            <Field label="Code postal"><input value={postal} onChange={(e) => setPostal(e.target.value)} maxLength={ORDER_FIELD_MAX.postalCode} className={input} /></Field>
          </div>
        </section>
      </div>

      {/* Right: delivery + payment + summary */}
      <div className="space-y-4">
        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Livraison</h2>
          <div className="space-y-3">
            <Field label="Méthode">
              <SelectField
                value={deliveryMethod}
                onChange={setDeliveryMethod}
                options={[
                  { value: "home_delivery", label: "Livraison à domicile" },
                  { value: "drive_by_pickup", label: "Drive" },
                  { value: "in_store", label: "Retrait en magasin" },
                ]}
              />
            </Field>
            {deliveryMethod === "home_delivery" && agents.length > 0 && (
              <Field label="Transporteur">
                <SelectField
                  value={agentId}
                  onChange={setAgentId}
                  placeholder="Tarif de base"
                  options={[{ value: "", label: "Tarif de base" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
                />
              </Field>
            )}
            {deliveryMethod !== "home_delivery" && (
              <Field label="Point de retrait">
                <SelectField
                  value={pickupId}
                  onChange={setPickupId}
                  placeholder="Sélectionner un point"
                  options={pickups
                    .filter((p) => p.kind === deliveryMethod)
                    .map((p) => ({ value: p.id, label: p.name }))}
                />
              </Field>
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-border bg-card p-4">
          <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Paiement (hors-ligne)</h2>
          <div className="space-y-3">
            <Field label="Canal">
              <SelectField
                value={channel}
                onChange={setChannel}
                options={[
                  { value: "cash", label: "Espèces (payé)" },
                  { value: "bank_transfer", label: "Virement (payé)" },
                  { value: "cod", label: "À la livraison (COD)" },
                ]}
              />
            </Field>
            <Field label="Référence (optionnel)">
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={input} placeholder="N° reçu, virement…" />
            </Field>
            <Field label="Code promo (optionnel)">
              {coupons.length > 0 ? (
                <SelectField
                  value={promo}
                  onChange={setPromo}
                  searchable
                  options={[
                    { value: "", label: "— Aucun —" },
                    ...coupons.map((c) => ({ value: c.code, label: c.label })),
                  ]}
                />
              ) : (
                <p className="rounded-[14px] border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
                  Aucun code promo actif pour le moment.
                </p>
              )}
            </Field>
          </div>
        </section>

        <section className="rounded-[28px] border border-border bg-card p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Sous-total articles</span>
            <span className="font-semibold tabular-nums">{formatMoneyExact(subtotalCents)}</span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Livraison, TVA, remises et points sont calculés à la création.
          </p>
          <button
            type="button"
            disabled={pending || lines.length === 0}
            onClick={submit}
            className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Créer la commande
          </button>
          {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
        </section>
      </div>
    </div>
  );
}

function ProductHitRow({
  hit,
  onAdd,
}: {
  hit: ManualOrderProductHit;
  onAdd: (hit: ManualOrderProductHit, variantId: string) => void;
}) {
  const [variantId, setVariantId] = useState(hit.variants[0]?.id ?? "");
  return (
    <div className="flex items-center gap-2 border-b border-border/60 p-2 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{hit.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {hit.sku ? `${hit.sku} · ` : ""}
          {formatMoneyExact(hit.priceCents)}
        </p>
      </div>
      {hit.isVariable && hit.variants.length > 0 && (
        <SelectField
          size="sm"
          ariaLabel="Variante"
          value={variantId}
          onChange={setVariantId}
          options={hit.variants.map((v) => ({ value: v.id, label: v.label }))}
          className="w-[8rem] shrink-0"
          triggerClassName="h-8"
        />
      )}
      <button
        type="button"
        disabled={hit.isVariable && !variantId}
        onClick={() => onAdd(hit, hit.isVariable ? variantId : "")}
        className="inline-flex h-8 items-center gap-1 rounded-[10px] bg-primary px-2.5 text-[11px] font-bold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-50"
      >
        <Plus className="h-3 w-3" /> Ajouter
      </button>
    </div>
  );
}

function Field({
  label,
  children,
  required,
  error,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  error?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {error && <span className="block text-[11px] font-medium text-destructive">{error}</span>}
    </label>
  );
}
