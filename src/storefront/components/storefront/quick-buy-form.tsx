"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, Truck, Zap } from "lucide-react";
import { z } from "zod";

import { SelectField } from "@/components/ui/select-field";
import { placeQuickOrderAction } from "@/lib/actions/order";
import { planById, useShippingConfig } from "@/storefront/lib/cart";
import { careConfig, type Product } from "@/storefront/lib/catalog";
import { smoothBehavior } from "@/storefront/lib/motion";
import { fmtPrice } from "@/storefront/lib/productMeta";

const INK = "#0e1218";
// Brand accent via the theme token so a brand-color change re-skins the quick-buy
// sheet; used only in `style={{}}` here, where a var() resolves.
const CRIMSON = "var(--primary)";
const PAPER = "#f6f2ed";

const governorates = [
  "Tunis",
  "Ariana",
  "Ben Arous",
  "Manouba",
  "Nabeul",
  "Bizerte",
  "Sousse",
  "Monastir",
  "Mahdia",
  "Sfax",
  "Kairouan",
  "Gabès",
  "Médenine",
  "Autre",
];

const schema = z.object({
  name: z.string().trim().min(3, "Nom complet requis").max(80, "Nom trop long"),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9\s+]{8,15}$/, "Numéro de téléphone invalide"),
  address: z.string().trim().min(6, "Adresse de livraison requise").max(200, "Adresse trop longue"),
  note: z.string().trim().max(300, "Note trop longue").optional(),
});

type FieldKey = "name" | "phone" | "address" | "note";
const FIELD_ORDER: FieldKey[] = ["name", "phone", "address", "note"];

/**
 * Achat rapide — a one-step express-order form. On DESKTOP it transforms the buy
 * box in place (rendered inside the product card's <aside>, replacing the normal
 * buy-box content); on MOBILE the PDP renders it inside a dismissible bottom
 * sheet over the product. Either way « Retour » (onClose) returns to the product.
 *
 * Places a REAL order through the backend « achat express » system
 * (`placeQuickOrderAction` → `workflows.order.placeQuick`), COD + home delivery,
 * one idempotency key per mount. The PDP's chosen care plan (`carePlanId`) rides
 * along and is re-priced + charged server-side. Delivery only — in-store pickup needs
 * a real `pickupLocationId` (not wired), so it is omitted rather than submitting an
 * order the express workflow would reject.
 */
export type QuickBuyPrefill = {
  name?: string;
  phone?: string;
  address?: string;
  /** Gouvernorat — only applied when it matches one of the known options. */
  city?: string;
};

export function QuickBuyForm({
  product,
  qty,
  carePlanId = null,
  variantId = null,
  unitPrice,
  onClose,
  initial,
}: {
  product: Product;
  qty: number;
  carePlanId?: string | null;
  /** The resolved variant combo id (so the express order charges + records the
   *  exact color/storage the shopper picked, not the base product). */
  variantId?: string | null;
  /** The displayed unit price for the selected variant (defaults to the base
   *  product price when there is no variant), so the recap matches the PDP. */
  unitPrice?: number;
  onClose: () => void;
  /** Pre-fills the fields from the signed-in customer's last order / profile. */
  initial?: QuickBuyPrefill | null;
}) {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const [values, setValues] = useState({
    name: initial?.name?.trim() ?? "",
    phone: initial?.phone?.trim() ?? "",
    address: initial?.address?.trim() ?? "",
    // Only honour a prefilled gouvernorat when it's a known option, else "Tunis".
    city: initial?.city && governorates.includes(initial.city) ? initial.city : "Tunis",
    note: "",
  });
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [idemKey] = useState(() => crypto.randomUUID());
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedCare = useMemo(() => planById(product, carePlanId), [product, carePlanId]);
  const careCharge = selectedCare
    ? careConfig.chargePerUnit
      ? selectedCare.total * qty
      : selectedCare.total
    : 0;

  const { fee: baseFee, freeFrom } = useShippingConfig();
  const unit = unitPrice ?? product.price;
  const subtotal = unit * qty;
  const freeShipBase = subtotal + (careConfig.countsTowardFreeShipping ? careCharge : 0);
  const qualifiesFree = freeFrom > 0 && freeShipBase >= freeFrom;
  const fee = qualifiesFree ? 0 : baseFee;
  const total = subtotal + careCharge + fee;

  const set = (k: keyof typeof values, v: string) => setValues((p) => ({ ...p, [k]: v }));

  /* Bring the form into view (desktop morph can sit below the fold; in the mobile
     sheet this is a no-op since it's already on screen), then focus the first
     field so the shopper can start typing immediately. */
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start", behavior: smoothBehavior() });
    document.getElementById(`${uid}-name`)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [uid, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse(values);
    const next: Partial<Record<FieldKey, string>> = {};
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const k = String(i.path[0]) as FieldKey;
        if (FIELD_ORDER.includes(k)) next[k] = i.message;
      }
    }
    setErrors(next);
    const firstInvalid = FIELD_ORDER.find((k) => next[k]);
    if (firstInvalid) {
      document.getElementById(id(firstInvalid))?.focus();
      return;
    }

    setSubmitError(null);
    setState("sending");
    const res = await placeQuickOrderAction({
      quickProductId: product.id,
      quickVariantId: variantId ?? null,
      quickQuantity: qty,
      quickCarePlanId: carePlanId,
      fullName: values.name.trim(),
      contactPhone: values.phone.trim(),
      shipPhone: values.phone.trim(),
      contactEmail: "",
      streetLine1: values.address.trim(),
      city: values.city.trim(),
      region: values.city.trim() || "Tunis",
      paymentMethod: "cod",
      notes: values.note.trim() || undefined,
      deliveryMethod: "home_delivery",
      idempotencyKey: idemKey,
    });

    if (!res.ok) {
      setState("idle");
      setSubmitError(res.message ?? "La commande n'a pas pu être enregistrée. Réessayez.");
      return;
    }
    if (res.redirectUrl) {
      window.location.href = res.redirectUrl;
      return;
    }
    setOrderNumber(res.orderNumber ?? null);
    setState("done");
  };

  const describe = (k: FieldKey) =>
    errors[k] ? { "aria-invalid": true as const, "aria-describedby": id(`${k}-error`) } : {};
  const errorLine = (k: FieldKey) =>
    errors[k] ? (
      <p id={id(`${k}-error`)} className="mt-1.5 pl-1 text-[12px] font-medium text-destructive">
        {errors[k]}
      </p>
    ) : null;

  const fieldCls =
    "h-[52px] w-full rounded-[16px] border border-border bg-background px-4 text-[15px] text-foreground outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/15";
  const labelCls = "mb-1.5 block pl-1 text-[13px] font-semibold text-muted-foreground";

  if (state === "done") {
    return (
      <div ref={rootRef} className="flex flex-col items-center gap-4 py-6 text-center" style={{ color: INK }}>
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#16a34a] text-white">
          <Check size={30} />
        </span>
        <h2 className="text-[22px] font-extrabold">
          {orderNumber ? `Commande ${orderNumber} enregistrée` : "Commande enregistrée"}
        </h2>
        <p className="max-w-[40ch] text-[15px] leading-relaxed text-[#3d4046]">
          Merci {values.name.trim().split(" ")[0]} — un conseiller Tokyo Store vous appelle au{" "}
          <span className="font-semibold text-[#0e1218]">{values.phone}</span> pour confirmer la livraison.
        </p>
        <div className="w-full rounded-[18px] p-4 text-left text-[13px]" style={{ background: PAPER }}>
          <p className="font-semibold leading-snug">{product.title}</p>
          <p className="mt-1 text-[#5b5d62]">
            Quantité : {qty} · Total :{" "}
            <span className="font-bold tabular-nums" style={{ color: CRIMSON }}>
              {fmtPrice(total)} TND
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-1 h-[52px] w-full rounded-full border-[1.5px] border-[#0e1218] bg-white text-[15px] font-bold text-[#0e1218] transition-colors hover:bg-[#0e1218] hover:text-white"
        >
          Retour au produit
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-5" style={{ color: INK }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Retour au produit"
          className="flex h-11 w-11 flex-[0_0_44px] items-center justify-center rounded-full border border-[#ece6df] bg-white text-[#0e1218] transition-colors hover:bg-[#f6f2ed]"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[20px] font-extrabold leading-tight">
            <Zap size={18} style={{ color: CRIMSON }} /> Achat rapide
          </h2>
          <p className="truncate text-[12px] text-[#5b5d62]">{product.title}</p>
        </div>
      </div>

      {/* Recap */}
      <div className="flex h-14 items-center justify-between gap-3 rounded-full px-5" style={{ background: PAPER }}>
        <span className="flex items-center gap-2 text-[13px] text-[#5b5d62]">
          <Truck size={15} style={{ color: CRIMSON }} /> Quantité {qty}
          {qualifiesFree ? " · Livraison offerte" : ""}
        </span>
        <span className="text-[16px] font-bold tabular-nums" style={{ color: CRIMSON }}>
          {fmtPrice(total)} TND
        </span>
      </div>

      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor={id("name")} className={labelCls}>
            Nom et prénom
          </label>
          <input
            id={id("name")}
            type="text"
            autoComplete="name"
            maxLength={80}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            className={fieldCls}
            {...describe("name")}
          />
          {errorLine("name")}
        </div>
        <div>
          <label htmlFor={id("phone")} className={labelCls}>
            Téléphone
          </label>
          <input
            id={id("phone")}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="ex. 50 059 160"
            maxLength={15}
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            className={fieldCls}
            {...describe("phone")}
          />
          {errorLine("phone")}
        </div>
        <div>
          <label htmlFor={id("address")} className={labelCls}>
            Adresse de livraison
          </label>
          <input
            id={id("address")}
            type="text"
            autoComplete="street-address"
            maxLength={200}
            value={values.address}
            onChange={(e) => set("address", e.target.value)}
            className={fieldCls}
            {...describe("address")}
          />
          {errorLine("address")}
        </div>
        <div>
          <label className={labelCls}>Gouvernorat</label>
          {/* Themed custom listbox (crimson) — replaces the native <select>
              whose OS-drawn option popup ignored the theme. */}
          <SelectField
            ariaLabel="Gouvernorat"
            value={values.city}
            onChange={(v) => set("city", v)}
            options={governorates.map((g) => ({ value: g, label: g }))}
            searchable
            triggerClassName="h-[52px]"
          />
        </div>
        <div>
          <label htmlFor={id("note")} className={labelCls}>
            Note <span className="font-normal text-[#5b5d62]">(facultatif)</span>
          </label>
          <textarea
            id={id("note")}
            maxLength={300}
            rows={2}
            value={values.note}
            onChange={(e) => set("note", e.target.value)}
            className={`${fieldCls} h-auto py-3`}
            {...describe("note")}
          />
        </div>

        {selectedCare && (
          <div className="flex items-center justify-between gap-2 rounded-[16px] px-4 py-3" style={{ background: PAPER }}>
            <span className="text-[13px] font-semibold">{selectedCare.label}</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: CRIMSON }}>
              +{fmtPrice(careCharge)} TND
            </span>
          </div>
        )}

        {submitError && (
          <p
            role="alert"
            className="rounded-[14px] border border-[#b00020]/30 bg-[#fdecec] px-3 py-2 text-[13px] font-medium text-[#b00020]"
          >
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={state === "sending"}
          className="flex h-[56px] w-full items-center justify-center gap-2 rounded-full border-none text-[16px] font-bold text-white transition-[filter] hover:brightness-95 disabled:opacity-70"
          style={{ background: CRIMSON }}
        >
          {state === "sending" ? (
            <>
              <Loader2 size={18} className="animate-spin" /> Envoi…
            </>
          ) : (
            <>
              Confirmer la commande <span aria-hidden>·</span>{" "}
              <span className="tabular-nums">{fmtPrice(total)} TND</span>
            </>
          )}
        </button>
        <p className="text-center text-[12px] leading-snug text-[#5b5d62]">
          Paiement à la livraison · Sans engagement — un conseiller vous rappelle
        </p>
      </form>
    </div>
  );
}
