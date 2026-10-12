"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";

import {
  createPromotionAction,
  updatePromotionAction,
} from "@/lib/actions/promotion";
import { type ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import { minorToDinars } from "@/lib/price";
import { buildAutoPromoName } from "@/lib/promotions/auto-name";
import { parseStoreLocalDateTime, storeLocalDateTimeInput } from "@/lib/time/store-tz";
import { SegmentRuleBuilder, isBuilderTreeValid } from "@/app/admin/marketing/segments/segment-builder";
import { isGroup, type RuleNode } from "@/lib/promotions/rule-tree";

export type ScopeChoice = { id: string; name: string };

/** A fresh audience rule seed (opted-in marketing) when the admin enables targeting. */
const NEW_AUDIENCE_TREE: RuleNode = { op: "and", children: [{ kind: "marketing_opted_in" }] };

export type PromotionFormInitial = {
  id: string;
  name: string;
  /** Targeting (code/URL promos only). Empty across both = PUBLIC promo. */
  targetSegmentIds: string[];
  targetCustomerEmails: string[];
  triggerKind: "auto" | "code" | "url";
  code: string | null;
  urlSlug: string | null;
  scope: "product" | "category" | "brand" | "cart" | "targeted";
  scopeId: string | null;
  /** MULTI-target set (scope='targeted'): the products/categories/brands the promo
   *  covers. Empty for the single-scope kinds. A product target may pin a single
   *  `variantId` (migration 0173) — the promo then applies ONLY to that variant. */
  scopeTargets: Array<{
    targetType: "product" | "category" | "brand";
    targetId: string;
    variantId?: string | null;
  }>;
  discountType: "percent" | "fixed";
  discountValue: number;
  /** Optional cap on a percent discount (millimes). null = uncapped. */
  maxDiscountCents: number | null;
  minCartCents: number;
  /** Optional upper cart bound (millimes). null = no upper bound. */
  maxCartCents: number | null;
  maxUses: number | null;
  maxUsesPerUser: number | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Scheduled email-announcement instant (ISO). null = no scheduled announce. */
  announceAt: string | null;
  /** When the announcement was fired (ISO) — read-only display. null = never announced. */
  announcedAt: string | null;
  isActive: boolean;
  isStackable: boolean;
  /** Cart coupon excludes already-on-sale lines from its discount base. */
  excludeDiscountedItems: boolean;
  /** The promo zeroes shipping (code/URL cart promos). */
  grantsFreeShipping: boolean;
  firstOrderOnly: boolean;
  /** Inline audience rule (compound rule_tree). null = no audience targeting. */
  audienceRuleTree: RuleNode | null;
  displayPriority: number;
};

const DEFAULT_INITIAL: PromotionFormInitial = {
  id: "",
  name: "",
  targetSegmentIds: [],
  targetCustomerEmails: [],
  triggerKind: "auto",
  code: null,
  urlSlug: null,
  scope: "cart",
  scopeId: null,
  scopeTargets: [],
  discountType: "percent",
  discountValue: 10,
  maxDiscountCents: null,
  minCartCents: 0,
  maxCartCents: null,
  maxUses: null,
  maxUsesPerUser: null,
  startsAt: null,
  endsAt: null,
  announceAt: null,
  announcedAt: null,
  isActive: true,
  isStackable: false,
  excludeDiscountedItems: false,
  grantsFreeShipping: false,
  firstOrderOnly: false,
  audienceRuleTree: null,
  displayPriority: 0,
};

/** Random readable coupon code — uppercase, no ambiguous chars (I/L/O/0/1). */
function genCouponCode(len = 8): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

// Convert a stored ISO instant → datetime-local input value, in the STORE zone
// (Africa/Tunis) so the wall-clock an operator typed round-trips exactly,
// regardless of their browser zone. Inverse of the server-side parse.
const toDateTimeLocal = storeLocalDateTimeInput;

/** Is a store-local `datetime-local` window NOT live right now (starts later, or
 *  already ended)? Evaluated in event handlers / the state initialiser only. */
function scheduleNotLive(startsLocal: string, endsLocal: string): boolean {
  const now = Date.now();
  const starts = parseStoreLocalDateTime(startsLocal);
  const ends = parseStoreLocalDateTime(endsLocal);
  return (starts != null && starts.getTime() > now) || (ends != null && ends.getTime() <= now);
}

export function PromotionForm({
  mode,
  initial = DEFAULT_INITIAL,
  products,
  categories,
  brands,
  productVariants = [],
  scopeTruncated,
  segments = [],
  cancelHref,
  /** Pre-selected scope+id for the "create promo for product X" inline flow. */
  lockScope,
  autoName,
  onSuccess,
  onCancel,
  onPendingChange,
}: {
  mode: "create" | "edit";
  initial?: PromotionFormInitial;
  products: ScopeChoice[];
  categories: ScopeChoice[];
  brands: ScopeChoice[];
  /** Flat variant options for the "cible une variante précise" picker — each id is
   *  `"<productId>:<variantId>"`, name is "Produit — Variante" (scope-choices.ts).
   *  A checked variant narrows the promo to THAT variant only (migration 0173). */
  productVariants?: ScopeChoice[];
  /** Which scope-target lists were capped at `cap` rows by the page loader
   *  (more rows exist than listed) — shows a notice under the picker. Omitted =
   *  none (scope-choices.ts). */
  scopeTruncated?: {
    cap: number;
    product: boolean;
    category: boolean;
    brand: boolean;
    productVariant?: boolean;
  };
  /** Customer segments to target. Empty = none defined yet. */
  segments?: ScopeChoice[];
  cancelHref: string;
  lockScope?: { scope: "product" | "category" | "brand"; id: string };
  /** Inline-modal flow: auto-compose the (customer-facing) name from the live discount +
   *  this entity name (the manual name field is hidden). */
  autoName?: string;
  /** Inline-modal flow: called once per successful submit (host closes + refreshes). */
  onSuccess?: (id?: string) => void;
  /** Inline-modal flow: render a « Annuler » button instead of the cancel link. */
  onCancel?: () => void;
  /** Report submit-in-flight so a host modal can block dismissal (closing
   *  mid-submit would unmount before onSuccess fires → phantom create + no refresh). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const action = mode === "create" ? createPromotionAction : updatePromotionAction;
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    action,
    null,
  );

  // Mirror server schema on the client so the dropdowns react: hide
  // unrelated fields when trigger/scope change.
  const [triggerKind, setTriggerKind] = useState<PromotionFormInitial["triggerKind"]>(
    initial.triggerKind,
  );
  const [scope, setScope] = useState<PromotionFormInitial["scope"]>(
    lockScope?.scope ?? initial.scope,
  );
  const [scopeId, setScopeId] = useState<string>(
    lockScope?.id ?? initial?.scopeId ?? "",
  );
  const [discountType, setDiscountType] = useState<PromotionFormInitial["discountType"]>(
    initial.discountType,
  );
  // Controlled so the "Générer" button can fill it.
  const [code, setCode] = useState<string>(initial.code ?? "");
  // Controlled so the discount-value field can relax to 0 (free-shipping-only).
  const [grantsFreeShipping, setGrantsFreeShipping] = useState<boolean>(initial.grantsFreeShipping);
  // Inline audience rule — the compound rule_tree builder (reused from Segments).
  const [audienceEnabled, setAudienceEnabled] = useState<boolean>(initial.audienceRuleTree != null);
  const [audienceTree, setAudienceTree] = useState<RuleNode>(
    initial.audienceRuleTree && isGroup(initial.audienceRuleTree)
      ? initial.audienceRuleTree
      : NEW_AUDIENCE_TREE,
  );
  // Controlled so the auto-generated name (below) reacts live to the discount.
  // Holds the DISPLAYED value: dinars for a fixed amount, raw 1-100 for percent.
  const [discountValue, setDiscountValue] = useState<string>(
    String(initial.discountType === "fixed" ? minorToDinars(initial.discountValue) : initial.discountValue),
  );
  const [urlSlug, setUrlSlug] = useState<string>(initial.urlSlug ?? "");
  // « Annoncer par email » only mails a promo that is LIVE when it's created (the
  // announcement re-checks it, and there's no later « Annoncer » action), so the
  // checkbox is disabled while the promo is inactive or scheduled outside « now ».
  // The inputs stay uncontrolled; these just mirror them for that gate.
  const [isActive, setIsActive] = useState<boolean>(initial.isActive);
  const [startsAtLocal, setStartsAtLocal] = useState<string>(() => toDateTimeLocal(initial.startsAt));
  const [endsAtLocal, setEndsAtLocal] = useState<string>(() => toDateTimeLocal(initial.endsAt));
  const [outsideWindow, setOutsideWindow] = useState<boolean>(() =>
    scheduleNotLive(toDateTimeLocal(initial.startsAt), toDateTimeLocal(initial.endsAt)),
  );
  // A scheduled announce (announce_at) is mutually exclusive with the immediate
  // create-time announce checkbox — track it so each disables the other.
  const [announceAtLocal, setAnnounceAtLocal] = useState<string>(() => toDateTimeLocal(initial.announceAt));
  // The immediate « annoncer à la création » checkbox needs the promo live NOW and
  // no scheduled announce set.
  const announceBlocked = !isActive || outsideWindow || Boolean(announceAtLocal);

  // Auto-name mode (inline product modal): compose a readable name from
  // the live discount + trigger + the locked entity, so the merchant never types one.
  const autoGeneratedName = autoName
    ? buildAutoPromoName({
        triggerKind,
        discountType,
        discountValue,
        code,
        urlSlug,
        grantsFreeShipping,
        entityName: autoName,
      })
    : "";

  // Fire onSuccess ONCE per successful submit (the action returns a fresh state
  // object each call, so this effect runs on each ok result — the modal closes).
  const lastHandledRef = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state?.ok && onSuccess && state !== lastHandledRef.current) {
      lastHandledRef.current = state;
      onSuccess("id" in state ? (state.id as string | undefined) : undefined);
    }
  }, [state, onSuccess]);

  // Report submit-in-flight so a host modal can block dismissal.
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const fieldError = (key: string): string | undefined => {
    if (!state || state.ok || !("fieldErrors" in state)) return undefined;
    return state.fieldErrors?.[key];
  };
  // The workflow's generic « Validation échouée » doesn't say WHICH field is
  // wrong, and some error keys have no inline slot (e.g. maxUses, the hidden
  // auto-name) — so the banner also carries the first field message. Skipped
  // when the banner message is already specific (a conflict, or a message that
  // IS one of the field messages, like the « Aucune cible valide » refusal).
  const fieldMessages = state && !state.ok ? Object.values(state.fieldErrors ?? {}) : [];
  const firstFieldError =
    state && !state.ok && state.error === "validation" && !fieldMessages.includes(state.message)
      ? fieldMessages.find(Boolean)
      : undefined;

  return (
    <form action={formAction} className="space-y-6">
      {mode === "edit" && (
        <input type="hidden" name="promotionId" value={initial.id} />
      )}

      {state && (
        <div
          className={`rounded-[14px] border px-4 py-3 text-sm ${
            state.ok
              ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
              : "border-[#f6d3dc] bg-[#fdecef] text-[#d40530]"
          }`}
          role="status"
        >
          {state.ok
            ? state.message ?? "Enregistré."
            : firstFieldError
              ? `${state.message} : ${firstFieldError}`
              : state.message}
        </div>
      )}

      {/* ─── Identity ────────────────────────────────────────────────── */}
      <Section title="Identité">
        {autoName ? (
          <>
            {/* Auto-named: no manual entry — the name is composed from the
                discount + product and submitted via this hidden input. */}
            <input type="hidden" name="name" value={autoGeneratedName} />
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] px-3 py-2">
              <p className="text-[13px] font-bold text-foreground">
                Nom affiché au client (généré automatiquement)
              </p>
              <p className="mt-0.5 text-sm font-medium text-foreground">{autoGeneratedName}</p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Composé d&apos;après la réduction et le produit, visible par les clients (panier, emails). Renommable ensuite depuis la page de la promotion.
            </p>
          </>
        ) : (
          <Field
            name="name"
            label="Nom (affiché au client)"
            required
            defaultValue={initial.name}
            error={fieldError("name")}
            hint="Visible par les clients (panier, message du coupon, email d'annonce) — n'y mettez pas de note interne."
          />
        )}
      </Section>

      {/* ─── Trigger ─────────────────────────────────────────────────── */}
      <Section
        title="Déclencheur"
        hint="« Auto » s'applique dès que le panier matche. « Code » exige une saisie au paiement. « URL » active la promo via /promo/<slug> (cookie)."
      >
        <SelectField
          name="triggerKind"
          label="Type"
          value={triggerKind}
          onChange={(v) => setTriggerKind(v as typeof triggerKind)}
          error={fieldError("triggerKind")}
          options={[
            { value: "auto", label: "Automatique" },
            { value: "code", label: "Code coupon" },
            { value: "url", label: "URL partagée" },
          ]}
        />
        {triggerKind === "code" && (
          <label className="block">
            <span className="text-[13px] font-bold text-foreground">
              Code (insensible à la casse)
              <span className="ml-0.5 text-destructive">*</span>
            </span>
            <div className="mt-1 flex gap-2">
              <input
                name="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ex: BLACKFRIDAY20"
                required
                className="h-11 flex-1 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
              />
              <button
                type="button"
                onClick={() => setCode(genCouponCode())}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[14px] border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-surface"
              >
                <Wand2 className="h-3.5 w-3.5" /> Générer
              </button>
            </div>
            {fieldError("code") && (
              <p className="mt-1 text-[11px] text-destructive">{fieldError("code")}</p>
            )}
          </label>
        )}
        {triggerKind === "url" && (
          <Field
            name="urlSlug"
            label="Slug URL"
            placeholder="ex: early-bird (donnera /promo/early-bird)"
            value={urlSlug}
            onChange={setUrlSlug}
            error={fieldError("urlSlug")}
            required
          />
        )}
      </Section>

      {/* ─── Scope ──────────────────────────────────────────────────── */}
      <Section
        title="Cible"
        hint="Choisissez à quel ensemble la promotion s'applique. Un coupon (code/URL) avec une portée produit / catégorie / marque ne réduit QUE les articles correspondants du panier. Pour une promo sur un produit créée depuis le produit lui-même, la cible est verrouillée."
      >
        <SelectField
          name="scope"
          label="Portée"
          value={scope}
          onChange={(v) => setScope(v as typeof scope)}
          disabled={Boolean(lockScope)}
          options={[
            { value: "cart", label: "Panier entier" },
            { value: "product", label: "Un produit" },
            { value: "category", label: "Une catégorie" },
            { value: "brand", label: "Une marque" },
            { value: "targeted", label: "Ciblage multiple (produits / catégories / marques)" },
          ]}
        />
        {scope === "targeted" && (
          <div className="space-y-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Cochez tout ce que la promotion doit couvrir — n&apos;importe quel mélange de
              produits, catégories et marques. Une catégorie inclut ses sous-catégories.
            </p>
            {fieldError("scopeTargets") && (
              <p role="alert" className="text-[11px] font-medium text-destructive">
                {fieldError("scopeTargets")}
              </p>
            )}
            <ScrollCheckboxGroup
              legend="Produits"
              name="scopeTargetProduct"
              options={products}
              // WHOLE-PRODUCT targets only (variantId null). A variant-constrained target
              // carries the same productId but must NOT pre-check the product box — that
              // box means "toutes les variantes"; the variant lives in the picker below.
              selected={initial.scopeTargets
                .filter((t) => t.targetType === "product" && !t.variantId)
                .map((t) => t.targetId)}
              emptyLabel="Aucun produit listé."
            />
            <ScrollCheckboxGroup
              legend="Catégories"
              name="scopeTargetCategory"
              options={categories}
              selected={initial.scopeTargets.filter((t) => t.targetType === "category").map((t) => t.targetId)}
              emptyLabel="Aucune catégorie listée."
            />
            <ScrollCheckboxGroup
              legend="Marques"
              name="scopeTargetBrand"
              options={brands}
              selected={initial.scopeTargets.filter((t) => t.targetType === "brand").map((t) => t.targetId)}
              emptyLabel="Aucune marque listée."
            />
            {productVariants.length > 0 && (
              <div className="space-y-1.5">
                <ScrollCheckboxGroup
                  legend="Variantes précises (optionnel)"
                  name="scopeTargetProductVariant"
                  options={productVariants}
                  selected={initial.scopeTargets
                    .filter((t) => t.targetType === "product" && t.variantId)
                    .map((t) => `${t.targetId}:${t.variantId}`)}
                  emptyLabel="Aucune variante à cibler."
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Cochez une variante pour n&apos;appliquer la promotion qu&apos;à celle-ci. Le produit
                  correspondant n&apos;a alors pas besoin d&apos;être coché ci-dessus : cocher des
                  variantes remplace le ciblage du produit entier.
                </p>
              </div>
            )}
            {(scopeTruncated?.product ||
              scopeTruncated?.category ||
              scopeTruncated?.brand ||
              scopeTruncated?.productVariant) && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Listes limitées aux {scopeTruncated?.cap} premiers éléments (ordre alphabétique). Pour
                cibler un élément absent, créez d&apos;abord une promotion depuis sa page, ou réduisez
                le catalogue listé.
              </p>
            )}
          </div>
        )}
        {scope !== "cart" && scope !== "targeted" && (
          <SelectField
            name="scopeId"
            label="Élément ciblé"
            value={scopeId}
            onChange={setScopeId}
            disabled={Boolean(lockScope)}
            error={fieldError("scopeId")}
            options={(() => {
              const list =
                scope === "product"
                  ? products
                  : scope === "category"
                    ? categories
                    : brands;
              return [
                { value: "", label: "— Choisir —" },
                ...list.map((c) => ({ value: c.id, label: c.name })),
                // Safety net: the promotion's CURRENT target (initial / locked
                // scope + id) that the caller didn't list must not render as
                // the empty placeholder while the hidden input still holds it.
                // The page loaders (scope-choices.ts) normally include it.
                ...(scopeId &&
                scope === (lockScope?.scope ?? initial.scope) &&
                scopeId === (lockScope?.id ?? initial.scopeId) &&
                !list.some((c) => c.id === scopeId)
                  ? [{ value: scopeId, label: "Élément actuel (hors liste)" }]
                  : []),
              ];
            })()}
          />
        )}
        {scope !== "cart" && scope !== "targeted" && !lockScope && scopeTruncated?.[scope] && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Liste limitée aux {scopeTruncated.cap} premiers éléments (ordre alphabétique).
            {scope === "product"
              ? " Pour cibler un produit absent de la liste, créez la promotion depuis sa fiche produit (bloc « Promotions sur ce produit »)."
              : " Pour un élément absent de la liste, créez la promotion depuis sa page d'administration."}
          </p>
        )}
      </Section>

      {/* ─── Targeting (code/URL only) ──────────────────────────────── */}
      {triggerKind !== "auto" && (
        <Section
          title="Ciblage (optionnel)"
          hint="Vide = promotion publique (tous les clients). Sinon, réservée aux cibles choisies (segments et/ou clients). Réservé aux codes et URL. Si aucune des cibles saisies n'est valide, l'enregistrement est refusé (la promotion ne devient jamais publique par erreur)."
        >
          {fieldError("targets") && (
            <p role="alert" className="text-[11px] font-medium text-destructive">
              {fieldError("targets")}
            </p>
          )}
          {segments.length > 0 && (
            <CheckboxGroup
              legend="Segments clients"
              name="targetSegment"
              options={segments}
              selected={initial.targetSegmentIds}
            />
          )}
          <Field
            name="targetCustomerEmails"
            label="Clients spécifiques (emails)"
            multiline
            defaultValue={initial.targetCustomerEmails.join(", ")}
            error={fieldError("targetCustomerEmails")}
            hint="Emails séparés par des virgules ou retours à la ligne. Chaque client doit avoir un compte (sinon ignoré, avec un avertissement)."
          />

          {/* Inline audience rule — the SAME compound builder as Clients→Segments
              (anniversaire / panier / démographie …). A promo with a rule is
              réservée aux clients qui la satisfont (en plus des cibles ci-dessus).
              Buyer-aware → code/URL only. */}
          <div className="rounded-[22px] border border-border bg-[#fbf9f8] p-3">
            <Checkbox
              name="__audienceEnabled"
              label="Cibler par règle d'audience (anniversaire, panier, démographie…)"
              defaultChecked={audienceEnabled}
              onChange={setAudienceEnabled}
            />
            {audienceEnabled && (
              <div className="mt-3">
                <SegmentRuleBuilder value={audienceTree} onChange={setAudienceTree} />
                {!isBuilderTreeValid(audienceTree) && (
                  <p role="alert" className="mt-2 text-[11px] font-medium text-destructive">
                    La règle d&apos;audience est incomplète — chaque groupe doit contenir au moins une condition valide.
                  </p>
                )}
                {fieldError("audienceRuleTree") && (
                  <p role="alert" className="mt-1 text-[11px] font-medium text-destructive">
                    {fieldError("audienceRuleTree")}
                  </p>
                )}
              </div>
            )}
            {/* The RuleNode is posted as a JSON blob; empty when disabled so the
                workflow clears any prior rule. */}
            <input
              type="hidden"
              name="audienceRuleTree"
              value={audienceEnabled && isBuilderTreeValid(audienceTree) ? JSON.stringify(audienceTree) : ""}
            />
          </div>
        </Section>
      )}

      {/* ─── Discount maths ─────────────────────────────────────────── */}
      <Section title="Réduction">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            name="discountType"
            label="Type"
            value={discountType}
            onChange={(v) => setDiscountType(v as typeof discountType)}
            options={[
              { value: "percent", label: "Pourcentage" },
              { value: "fixed", label: "Montant fixe (TND)" },
            ]}
          />
          <Field
            name="discountValue"
            label={discountType === "percent" ? "Pourcentage (1-100)" : "Montant en TND"}
            type="number"
            min={grantsFreeShipping ? 0 : 1}
            max={discountType === "percent" ? 100 : undefined}
            step={discountType === "percent" ? "1" : "0.001"}
            value={discountValue}
            onChange={setDiscountValue}
            error={fieldError("discountValue")}
            hint={grantsFreeShipping ? "0 autorisé pour une promo « livraison offerte » seule." : undefined}
            required
          />
        </div>
        {discountType === "percent" && (
          <Field
            name="maxDiscountTnd"
            label="Plafond de remise (TND, optionnel)"
            type="number"
            min={0}
            step="0.001"
            defaultValue={
              initial.maxDiscountCents != null ? String(minorToDinars(initial.maxDiscountCents)) : ""
            }
            hint="Limite le montant d'une remise en %. Vide = sans plafond."
          />
        )}
      </Section>

      {/* ─── Conditions ─────────────────────────────────────────────── */}
      <Section title="Conditions">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            name="minCartCents"
            label="Panier minimum (TND)"
            type="number"
            min={0}
            step="0.001"
            defaultValue={String(minorToDinars(initial.minCartCents))}
            hint="0 = aucun minimum"
          />
          <Field
            name="maxCartTnd"
            label="Panier maximum (TND)"
            type="number"
            min={0}
            step="0.001"
            defaultValue={
              initial.maxCartCents != null ? String(minorToDinars(initial.maxCartCents)) : ""
            }
            error={fieldError("maxCartTnd")}
            hint="Vide = aucun maximum"
          />
          <Field
            name="maxUses"
            label="Utilisations max (vide = illimité)"
            type="number"
            min={1}
            defaultValue={initial.maxUses?.toString() ?? ""}
          />
          <Field
            name="maxUsesPerUser"
            label="Max par utilisateur"
            type="number"
            min={1}
            defaultValue={initial.maxUsesPerUser?.toString() ?? ""}
          />
        </div>
      </Section>

      {/* ─── Schedule ───────────────────────────────────────────────── */}
      <Section title="Planification">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="startsAt"
            label="Démarre le (facultatif)"
            type="datetime-local"
            defaultValue={toDateTimeLocal(initial.startsAt)}
            onChange={(v) => {
              setStartsAtLocal(v);
              setOutsideWindow(scheduleNotLive(v, endsAtLocal));
            }}
          />
          <Field
            name="endsAt"
            label="Termine le (facultatif)"
            type="datetime-local"
            defaultValue={toDateTimeLocal(initial.endsAt)}
            onChange={(v) => {
              setEndsAtLocal(v);
              setOutsideWindow(scheduleNotLive(startsAtLocal, v));
            }}
            error={fieldError("endsAt")}
            hint="Doit être après la date de début."
          />
        </div>
        <Field
          name="announceAt"
          label="Annoncer par email le (facultatif)"
          type="datetime-local"
          defaultValue={toDateTimeLocal(initial.announceAt)}
          onChange={setAnnounceAtLocal}
          error={fieldError("announceAt")}
          hint="À cette date, un email est envoyé une seule fois à l'audience de la promotion (clients opt-in / ciblés). Vide = pas d'annonce programmée. Incompatible avec l'annonce immédiate ci-dessous."
        />
        {initial.announcedAt && (
          <p className="text-[11px] font-medium text-[#15803d]">
            Annoncée le {new Date(initial.announcedAt).toLocaleString("fr-FR", { timeZone: "Africa/Tunis", dateStyle: "long", timeStyle: "short" })}.
          </p>
        )}
      </Section>

      {/* ─── Behaviour ──────────────────────────────────────────────── */}
      <Section title="Comportement">
        <div className="space-y-2">
          <Checkbox name="isActive" label="Active" defaultChecked={initial.isActive} onChange={setIsActive} />
          <Checkbox
            name="isStackable"
            label="Cumulable avec d'autres promotions (sur la même ligne)"
            defaultChecked={initial.isStackable}
          />
          {triggerKind !== "auto" && (
            <Checkbox
              name="excludeDiscountedItems"
              label="Exclure les articles déjà en promotion (le coupon ne s'applique pas aux lignes déjà soldées)"
              defaultChecked={initial.excludeDiscountedItems}
            />
          )}
          {triggerKind !== "auto" && (
            <Checkbox
              name="grantsFreeShipping"
              label="Offre la livraison gratuite"
              defaultChecked={initial.grantsFreeShipping}
              onChange={setGrantsFreeShipping}
            />
          )}
          {triggerKind !== "auto" && (
            <Checkbox
              name="firstOrderOnly"
              label="Réservé à la première commande (offre de bienvenue — compte requis)"
              defaultChecked={initial.firstOrderOnly}
            />
          )}
          {mode === "create" && (
            <Checkbox
              name="announceByEmail"
              label="Annoncer par email à l'audience (clients opt-in / ciblés) à la création"
              defaultChecked={false}
              disabled={announceBlocked}
              hint={
                announceAtLocal
                  ? "Indisponible : une annonce programmée est déjà définie ci-dessus (choisissez l'une ou l'autre)."
                  : announceBlocked
                    ? "Indisponible : l'annonce immédiate n'est envoyée que pour une promotion active dès sa création (pas désactivée, ni programmée plus tard, ni déjà terminée). Pour une promo à venir, utilisez « Annoncer par email le »."
                    : undefined
              }
            />
          )}
        </div>
        <Field
          name="displayPriority"
          label="Priorité (0-100, plus élevé = gagne en cas de conflit)"
          type="number"
          min={0}
          max={100}
          defaultValue={String(initial.displayPriority)}
        />
      </Section>

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface disabled:opacity-50"
          >
            Annuler
          </button>
        ) : (
          <Link
            href={cancelHref}
            className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
          >
            Annuler
          </Link>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {mode === "create" ? "Créer la promotion" : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}

// ─── tiny inputs (kept inline to match the rest of the admin look) ──
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
      {hint && <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  value,
  onChange,
  multiline,
  error,
  hint,
  min,
  max,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  /** Controlled value — pass with `onChange` (omit `defaultValue`). */
  value?: string;
  onChange?: (v: string) => void;
  multiline?: boolean;
  error?: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: string;
}) {
  const cls =
    "mt-2 h-[50px] w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";
  const controlled = value !== undefined;
  return (
    <label className="block">
      <span className="text-[13px] font-bold text-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {multiline ? (
        <textarea
          name={name}
          rows={3}
          placeholder={placeholder}
          defaultValue={controlled ? undefined : defaultValue}
          value={controlled ? value : undefined}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          className={`${cls} h-auto resize-y py-2`}
        />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          placeholder={placeholder}
          defaultValue={controlled ? undefined : defaultValue}
          value={controlled ? value : undefined}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          min={min}
          max={max}
          step={step}
          className={cls}
        />
      )}
      {hint && !error && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </label>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
  onChange,
  disabled,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** A disabled checkbox is not submitted (FormData omits it). */
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <label className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}>
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          disabled={disabled}
          onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
          className="h-4 w-4 rounded border-input accent-[var(--primary)]"
        />
        <span>{label}</span>
      </label>
      {hint && <p className="mt-1 pl-6 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Multi-select as a SCROLLABLE checkbox list — for the multi-target scope picker,
 *  where each list can hold up to the page cap (product/category/brand). Posts via
 *  FormData.getAll(name). Renders `emptyLabel` when the option list is empty. */
function ScrollCheckboxGroup({
  legend,
  name,
  options,
  selected,
  emptyLabel,
}: {
  legend: string;
  name: string;
  options: ScopeChoice[];
  selected: string[];
  emptyLabel: string;
}) {
  const sel = new Set(selected);
  return (
    <fieldset>
      <legend className="text-[13px] font-bold text-foreground">
        {legend}
        {sel.size > 0 && <span className="ml-1 text-primary">({sel.size})</span>}
      </legend>
      {options.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto rounded-[14px] border border-input bg-[#fbf9f8] p-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 rounded-[10px] px-1.5 py-1 text-[12px] hover:bg-surface">
              <input
                type="checkbox"
                name={name}
                value={o.id}
                defaultChecked={sel.has(o.id)}
                className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
              />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Multi-select as chips (FormData.getAll(name) on submit). */
function CheckboxGroup({
  legend,
  name,
  options,
  selected,
}: {
  legend: string;
  name: string;
  options: ScopeChoice[];
  selected: string[];
}) {
  const sel = new Set(selected);
  return (
    <fieldset>
      <legend className="text-[13px] font-bold text-foreground">
        {legend}
      </legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-input px-3 py-1.5 text-[12px]"
          >
            <input
              type="checkbox"
              name={name}
              value={o.id}
              defaultChecked={sel.has(o.id)}
              className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
            />
            {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
