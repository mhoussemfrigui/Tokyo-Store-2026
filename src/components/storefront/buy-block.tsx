"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Loader2,
  Lock,
  MapPin,
  Store,
  Truck,
  Zap,
} from "lucide-react";

import { placeQuickOrderAction } from "@/lib/actions/order";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { expressHomeOptionFees } from "@/lib/checkout/express-delivery-fees";
import { TUNISIA_GOVERNORATE_OPTIONS } from "@/lib/geo/tunisia";
import { useTrustCopy } from "@/components/storefront/trust-copy-provider";
import { useMoney } from "@/components/money-provider";
import { track, itemFromProduct } from "@/lib/tracking/funnel";
import { dinarsToMinor } from "@/lib/price";
import { ORDER_FIELD_MAX } from "@/lib/checkout/order-field-max";
import type { QuickBuyConfig } from "@/lib/checkout/quick-buy-config";
import type { DeliveryMethod, DeliveryOption } from "@/lib/checkout/delivery";

/**
 * Product buy-box module. Exports the {@link BuyBlockProduct} shape + the
 * express ("Acheter maintenant") {@link QuickBuyForm}, both consumed by the
 * product page (`product-client.tsx`) and the mobile bottom-sheet.
 *
 * Tracking funnel touched by the quick-buy form:
 *   - `add_shipping_info` on form submit
 *   - `purchase`          on confirmation page (handled there)
 */

export type BuyBlockProduct = {
  id?: string;
  slug: string;
  name: string;
  brand?: string;
  category?: string;
  price: number; // in TND major units (display)
  oldPrice?: number;
  /** Canonical integer cents — preferred over `price` for any analytics math. */
  priceCents?: number;
  /** Canonical integer cents for the compare-at price, if any. */
  oldPriceCents?: number;
  inStock: boolean;
  /** Resolved warranty (global→category→product cascade). Undefined ⇒ no
   *  warranty line is shown — we never assert coverage the product lacks. */
  warranty?: string;
  /** Per-product purchase-qty limits (L3) — seed + clamp the stepper so the
   *  default Add never errors on a min-qty product. null/undefined = no limit. */
  minPurchaseQty?: number | null;
  maxPurchaseQty?: number | null;
};

/**
 * Random v4 UUID for the express idempotency key. `crypto.randomUUID` needs a
 * secure context, so a plain-http preview (LAN IP) falls back to
 * `getRandomValues` with the v4 version / variant bits set by hand.
 */
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ─────────────────────────────────────── Delivery method metadata ── */

/** Customer-facing labels + icon per delivery method (FR). */
const DELIVERY_METHOD_META: Record<
  DeliveryMethod,
  { label: string; icon: typeof Truck }
> = {
  home_delivery: { label: "Livraison à domicile", icon: Truck },
  drive_by_pickup: { label: "Drive", icon: MapPin },
  in_store: { label: "Retrait en magasin", icon: Store },
};

/** The customer's resolved delivery selection (mirrors the submitted fields). */
type DeliverySelection = {
  method: DeliveryMethod;
  /** Chosen home-delivery agent (empty ⇒ the global base option). */
  agentId: string;
  /** Chosen pickup location for a pickup method (empty until picked). */
  pickupLocationId: string;
};

/* ─────────────────────────────────────────── Quick-buy form ── */

/**
 * The express ("Acheter maintenant") form. Used by the desktop BuyBlock morph
 * AND, exported, by the mobile bottom-sheet on the product page — so the
 * checkout.quick.* field toggles + delivery + payment behave identically on
 * both. `onBack` returns to the view (desktop) or closes the sheet (mobile).
 */
export function QuickBuyForm({
  product,
  productDbId,
  variantId,
  quantity,
  config,
  initialEmail,
  initialName,
  initialPhone,
  initialAddress,
  onBack,
}: {
  product: BuyBlockProduct;
  productDbId: string | null;
  variantId?: string | null;
  quantity: number;
  config: QuickBuyConfig;
  initialEmail: string;
  initialName: string;
  initialPhone: string;
  initialAddress: {
    fullName: string;
    streetLine1: string;
    streetLine2?: string | null;
    city: string;
    region?: string | null;
    postalCode?: string | null;
    country?: string | null;
    phone?: string | null;
  } | null;
  onBack: () => void;
}) {
  const money = useMoney();
  const router = useRouter();
  const trust = useTrustCopy();
  const [pending, startSubmit] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Idempotency key of this form: generated on the first submit and re-sent on
  // every retry of it, so a replayed / double-fired submit is refused
  // server-side instead of placing a second order. Cleared once an order is
  // placed (a form restored from the back-forward cache starts a new order).
  const idempotencyKeyRef = useRef<string | null>(null);

  // Delivery selection. Default = the FIRST offerable method (home delivery when
  // enabled, no agent — the server resolves that to the global flat-rate base),
  // with a pickup method's first point pre-selected: a store that disabled home
  // delivery must never submit it (the server refuses a disabled method). The
  // picker is shown when there's a real choice, and whenever the only method is
  // a pickup — so the customer sees they're collecting the order (and where). A
  // plain home-only setup keeps the 1-tap form.
  const deliveryMethods = availableMethods(config.delivery);
  const firstMethod: DeliveryMethod = deliveryMethods[0] ?? "home_delivery";
  const showDeliveryPicker =
    deliveryMethods.length > 1 ||
    config.delivery.home.length > 1 ||
    firstMethod !== "home_delivery";
  const [delivery, setDelivery] = useState<DeliverySelection>(() => ({
    method: firstMethod,
    agentId: "",
    pickupLocationId:
      firstMethod === "drive_by_pickup"
        ? config.delivery.driveBy[0]?.id ?? ""
        : firstMethod === "in_store"
          ? config.delivery.inStore[0]?.id ?? ""
          : "",
  }));
  // Live gouvernorat — drives the per-courier zone fees shown in the express
  // selector when region pricing is on, so the shown fee equals what
  // `resolveDelivery` charges. The free-shipping threshold is judged against the
  // live goods amount (price × quantity) — the config's fees are built at
  // subtotal 0, so without it a watch above the threshold still read « + 7 TND ».
  const [region, setRegion] = useState<string>(initialAddress?.region ?? "");
  const goodsCents = (product.priceCents ?? dinarsToMinor(product.price)) * quantity;
  const zonedHome = useMemo<DeliveryOption[]>(
    () =>
      expressHomeOptionFees(config.delivery.home, {
        goodsCents,
        region,
        zoneFeeIndex: config.delivery.zoneFeeIndex,
        homeFreeThresholds: config.delivery.homeFreeThresholds,
      }),
    [
      config.delivery.home,
      config.delivery.zoneFeeIndex,
      config.delivery.homeFreeThresholds,
      region,
      goodsCents,
    ],
  );
  const deliveryForSection = useMemo(
    () => ({ ...config.delivery, home: zonedHome }),
    [config.delivery, zonedHome],
  );

  // ── Payment options ──────────────────────────────────────────────────────
  // Express offers exactly the methods the admin enabled on the Paiement page —
  // the same set the cart checkout shows — and the customer chooses COD vs an
  // online gateway. (No express-specific routing: the server re-enforces the
  // allowed set via resolvePaymentMethod.)
  const codRadioShown = config.payment.codEnabled;

  const gatewayOptions = (
    [
      config.payment.clictopayEnabled && {
        value: "clictopay",
        label: config.payment.clictopayLabel,
        desc: config.payment.clictopayDescription,
      },
      config.payment.flouciEnabled && {
        value: "flouci",
        label: config.payment.flouciLabel,
        desc: config.payment.flouciDescription,
      },
    ].filter(Boolean) as { value: string; label: string; desc: string }[]
  );

  // Which radio starts checked: COD-if-shown, else the first gateway. Falls
  // back to "" (nothing checked) only when no method is offered. Matches the
  // cart checkout's default-selection rule.
  const defaultMethod = codRadioShown ? "cod" : gatewayOptions[0]?.value ?? "";

  const submit = (formData: FormData) => {
    if (!productDbId) {
      setErr("Produit indisponible.");
      return;
    }
    setErr(null);

    // Read the radio's actual value (COD or an online gateway — ClicToPay,
    // Flouci) and whitelist it against the `PlaceOrderInput` enum so a typo or
    // stale form value can't slip through as an arbitrary string.
    const allowedMethods = ["cod", "clictopay", "flouci", "card_stripe"] as const;
    const rawMethod = String(formData.get("paymentMethod") ?? "cod").trim();
    const paymentMethod = (allowedMethods as readonly string[]).includes(rawMethod)
      ? (rawMethod as (typeof allowedMethods)[number])
      : "cod";

    const payload = {
      contactEmail: String(formData.get("email") ?? "").trim(),
      contactPhone: String(formData.get("phone") ?? "").trim() || undefined,
      fullName: String(formData.get("fullName") ?? "").trim(),
      streetLine1: String(formData.get("streetLine1") ?? "").trim(),
      streetLine2: String(formData.get("streetLine2") ?? "").trim() || undefined,
      city: String(formData.get("city") ?? "").trim(),
      region: String(formData.get("region") ?? "").trim() || undefined,
      postalCode: String(formData.get("postalCode") ?? "").trim() || undefined,
      country: "TN",
      shipPhone: String(formData.get("phone") ?? "").trim() || undefined,
      paymentMethod,
      notes: String(formData.get("notes") ?? "").trim() || undefined,
      // Delivery selection. The server re-validates + prices these via
      // `resolveDelivery`; an invalid/disabled choice is refused with a message
      // (never re-routed), so a tampered value can never under-charge shipping.
      deliveryMethod: delivery.method,
      deliveryAgentId:
        delivery.method === "home_delivery" && delivery.agentId
          ? delivery.agentId
          : undefined,
      pickupLocationId:
        delivery.method !== "home_delivery" && delivery.pickupLocationId
          ? delivery.pickupLocationId
          : undefined,
      quickProductId: productDbId,
      quickVariantId: variantId ?? null,
      quickQuantity: quantity,
      idempotencyKey: (idempotencyKeyRef.current ??= newIdempotencyKey()),
    };

    const unitCents = product.priceCents ?? dinarsToMinor(product.price);
    track("add_shipping_info", {
      value_cents: unitCents * quantity,
      items: [itemFromProduct({ ...product, quantity })],
      meta: { flow: "quick" },
    });

    startSubmit(async () => {
      const res = await placeQuickOrderAction(payload);
      if (!res.ok) {
        setErr(res.message ?? "Une erreur est survenue.");
        return;
      }
      idempotencyKeyRef.current = null;
      // Online payment: hand off to the gateway's hosted page.
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
        return;
      }
      // COD / no gateway: go straight to the confirmation page (the purchase
      // funnel event fires there, where we have the canonical order data).
      router.push(`/order/${res.orderId}?fresh=1`);
    });
  };

  return (
    <form action={submit} className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-3">
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className="inline-flex h-10 items-center gap-1 rounded-full border border-border/70 bg-background px-3.5 font-body text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:opacity-50"
        >
          <ChevronLeft className="h-3 w-3" strokeWidth={1.8} />
          Retour
        </button>
        <p className="font-body text-[0.6rem] uppercase tracking-[0.24em] text-olive">
          Achat Express
        </p>
      </div>

      <div className="mt-3.5 space-y-2.5">
        <Field name="fullName" label="Nom complet" required maxLength={ORDER_FIELD_MAX.name} defaultValue={initialAddress?.fullName ?? initialName} />
        {config.fields.email.enabled && (
          <Field
            name="email"
            label="Email"
            type="email"
            required={config.fields.email.required}
            maxLength={ORDER_FIELD_MAX.email}
            defaultValue={initialEmail}
          />
        )}
        {config.fields.phone.enabled && (
          <Field
            name="phone"
            label="Téléphone"
            type="tel"
            inputMode="tel"
            required={config.fields.phone.required}
            maxLength={ORDER_FIELD_MAX.phone}
            placeholder="+216 XX XXX XXX"
            defaultValue={initialAddress?.phone ?? initialPhone}
          />
        )}
        <Field
          name="streetLine1"
          label="Adresse"
          required
          maxLength={ORDER_FIELD_MAX.addressLine}
          defaultValue={initialAddress?.streetLine1 ?? ""}
        />
        {config.fields.streetLine2.enabled && (
          <Field
            name="streetLine2"
            label="Complément d'adresse"
            maxLength={ORDER_FIELD_MAX.addressLine}
            defaultValue={initialAddress?.streetLine2 ?? ""}
          />
        )}
        {(config.fields.city.enabled || config.fields.region.enabled) && (
          <div className="grid grid-cols-2 gap-2.5">
            {config.fields.city.enabled && (
              <Field
                name="city"
                label="Ville"
                required
                maxLength={ORDER_FIELD_MAX.place}
                defaultValue={initialAddress?.city ?? ""}
              />
            )}
            {config.fields.region.enabled && (
              // Constrained governorate picker (value === canonical name) — not
              // free text — so the value cleanly matches the delivery-zone
              // governorate lists and drives the live zone-fee recompute.
              <SelectField
                name="region"
                label="Gouvernorat"
                options={TUNISIA_GOVERNORATE_OPTIONS}
                defaultValue={initialAddress?.region ?? ""}
                onChange={setRegion}
                placeholder="Sélectionner…"
              />
            )}
          </div>
        )}
        {config.fields.postalCode.enabled && (
          <Field
            name="postalCode"
            label="Code postal"
            inputMode="numeric"
            maxLength={ORDER_FIELD_MAX.postalCode}
            defaultValue={initialAddress?.postalCode ?? ""}
          />
        )}
        {config.fields.notes.enabled && (
          <Field name="notes" label="Notes (optionnel)" multiline maxLength={ORDER_FIELD_MAX.notes} />
        )}

        {showDeliveryPicker && (
          <DeliverySection
            delivery={deliveryForSection}
            selection={delivery}
            setSelection={setDelivery}
          />
        )}

        {/* COD is offered whenever the admin enabled it; the gateways below are
            shown when their provider is enabled. The customer picks one (the
            server re-enforces the allowed set, so a tampered client can't submit
            a disabled method). Grouped under a "Paiement" label so the sheet
            reads as distinct steps. */}
        {(codRadioShown || gatewayOptions.length > 0) && (
          <p className="border-t border-border/40 pt-3.5 font-body text-[0.6rem] font-medium uppercase tracking-[0.2em] text-olive">
            Paiement
          </p>
        )}
        {codRadioShown && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border/60 bg-card p-3 text-xs transition-all has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
            <input
              type="radio"
              name="paymentMethod"
              value="cod"
              defaultChecked={defaultMethod === "cod"}
              className="h-4 w-4 shrink-0 accent-[var(--primary)]"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-foreground">
                {config.payment.codLabel || "Paiement à la livraison"}
              </span>
              <span className="mt-0.5 block leading-snug text-muted-foreground">
                {config.payment.codDescription}
              </span>
            </span>
          </label>
        )}

        {gatewayOptions.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border/60 bg-card p-3 text-xs transition-all has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="paymentMethod"
              value={opt.value}
              defaultChecked={defaultMethod === opt.value}
              className="h-4 w-4 shrink-0 accent-[var(--primary)]"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-foreground">{opt.label}</span>
              <span className="mt-0.5 block leading-snug text-muted-foreground">
                {opt.desc} · paiement en ligne sécurisé
              </span>
            </span>
          </label>
        ))}
      </div>

      {err && (
        <p className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {err}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="btn-solid mt-4 h-12 w-full text-[0.65rem] tracking-[0.2em] md:tracking-[0.22em]"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
        ) : (
          <Zap className="h-4 w-4" strokeWidth={1.8} />
        )}
        {pending ? "Validation…" : `Confirmer · ${money.fromDinars(product.price * quantity)}`}
      </button>

      <div className="mt-3.5 flex items-center justify-center gap-1.5 font-body text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground/70">
        <Lock className="h-3 w-3" strokeWidth={2} />
        {/* Never assert a delivery time the operator didn't configure: the eta
            clause is the admin checkout-copy label (TrustCopyProvider) and drops
            entirely when unset, leaving just the data-encryption assurance. */}
        Données chiffrées{trust.eta ? ` · ${trust.eta}` : ""}
      </div>
    </form>
  );
}

/* ─────────────────────────────────────────── Delivery section ── */

/** The methods that have at least one selectable option, in display order. */
function availableMethods(delivery: QuickBuyConfig["delivery"]): DeliveryMethod[] {
  const out: DeliveryMethod[] = [];
  if (delivery.home.length > 0) out.push("home_delivery");
  if (delivery.driveBy.length > 0) out.push("drive_by_pickup");
  if (delivery.inStore.length > 0) out.push("in_store");
  return out;
}

/**
 * Quick-buy delivery picker. Renders when more than one method (or more than
 * one home option) is offered, or when the only method is a pickup — a plain
 * home-only setup keeps the 1-tap form untouched (the submitted method defaults
 * to `home_delivery` with no agent, which the server resolves to the global
 * flat-rate base).
 *
 * The displayed fee is the preview (home fees re-judged against price × qty by
 * `expressHomeOptionFees`; recomputed authoritatively server-side at order
 * time). Inside the chosen method we surface an
 * agent/location `SelectField` when that method has more than one option.
 */
function DeliverySection({
  delivery,
  selection,
  setSelection,
}: {
  delivery: QuickBuyConfig["delivery"];
  selection: DeliverySelection;
  setSelection: (next: DeliverySelection) => void;
}) {
  const money = useMoney();
  const methods = availableMethods(delivery);

  // Pickup options for the currently-selected pickup method.
  const pickupOptions =
    selection.method === "drive_by_pickup"
      ? delivery.driveBy
      : selection.method === "in_store"
        ? delivery.inStore
        : [];

  const formatFee = (feeCents: number, freeApplied: boolean) =>
    freeApplied || feeCents === 0 ? "Offerte" : money.fromMinor(feeCents);

  // Home agent <select>: the global base ("") + one entry per agent. Each
  // label carries the fee so the customer sees the cost before choosing.
  const homeSelectOptions: SelectFieldOption[] = delivery.home.map((o) => ({
    value: o.id ?? "",
    label: o.label,
    description: formatFee(o.feeCents, o.freeApplied),
  }));

  const pickupSelectOptions: SelectFieldOption[] = pickupOptions.map((o) => ({
    value: o.id ?? "",
    label: o.label,
    description: formatFee(o.feeCents, o.freeApplied),
  }));

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <p className="font-body text-[0.6rem] font-medium uppercase tracking-[0.2em] text-olive">
        Mode de livraison
      </p>

      <div className="mt-2 grid gap-1.5">
        {methods.map((m) => {
          const meta = DELIVERY_METHOD_META[m];
          const Icon = meta.icon;
          const checked = selection.method === m;
          return (
            <label
              key={m}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2 text-xs transition ${
                checked
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-card hover:bg-surface"
              }`}
            >
              <input
                type="radio"
                name="deliveryMethodRadio"
                value={m}
                checked={checked}
                onChange={() =>
                  setSelection({
                    method: m,
                    // Reset the sub-selection to that method's first option so
                    // we never carry a stale agent/pickup id across methods.
                    agentId: "",
                    pickupLocationId:
                      m === "home_delivery"
                        ? ""
                        : (m === "drive_by_pickup"
                            ? delivery.driveBy[0]?.id
                            : delivery.inStore[0]?.id) ?? "",
                  })
                }
                className="h-4 w-4 shrink-0 accent-[var(--primary)]"
              />
              <Icon className="h-3.5 w-3.5 shrink-0 text-foreground" strokeWidth={2} />
              <span className="font-semibold text-foreground">{meta.label}</span>
            </label>
          );
        })}
      </div>

      {/* Home delivery: agent picker (only when there's a real choice). */}
      {selection.method === "home_delivery" && homeSelectOptions.length > 1 && (
        <div className="mt-2.5">
          <SelectField
            ariaLabel="Choix du livreur"
            size="sm"
            options={homeSelectOptions}
            value={selection.agentId}
            onChange={(v) => setSelection({ ...selection, agentId: v })}
          />
        </div>
      )}

      {/* Pickup methods: location picker. */}
      {(selection.method === "drive_by_pickup" || selection.method === "in_store") &&
        pickupSelectOptions.length > 0 && (
          <div className="mt-2.5">
            <SelectField
              ariaLabel="Choix du point de retrait"
              size="sm"
              options={pickupSelectOptions}
              value={selection.pickupLocationId}
              onChange={(v) => setSelection({ ...selection, pickupLocationId: v })}
            />
          </div>
        )}
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  multiline,
  inputMode,
  maxLength,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  inputMode?: "text" | "tel" | "numeric" | "email" | "url";
  /** Mirrors the server-side ORDER_FIELD_MAX cap so the shopper can't type past it. */
  maxLength?: number;
}) {
  const cls =
    "mt-1 h-10 w-full rounded-lg border border-border/60 bg-background px-3 font-body text-sm text-foreground placeholder:text-muted-foreground/45 transition-colors focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20";
  return (
    <label className="block">
      <span className="font-body text-[0.6rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-olive">*</span>}
      </span>
      {multiline ? (
        <textarea
          name={name}
          rows={2}
          placeholder={placeholder}
          defaultValue={defaultValue}
          maxLength={maxLength}
          className={`${cls} h-auto resize-none py-2`}
        />
      ) : (
        <input
          name={name}
          type={type}
          inputMode={inputMode}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          maxLength={maxLength}
          className={cls}
        />
      )}
    </label>
  );
}
