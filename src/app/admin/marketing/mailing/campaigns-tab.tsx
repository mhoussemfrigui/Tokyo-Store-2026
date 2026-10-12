"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, Info, Loader2, Send, Users } from "lucide-react";

import {
  createAndSendCampaignAction,
  previewAudienceCountAction,
} from "@/lib/actions/mailing";
import { type ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import { AdminNote, AdminCallout } from "@/components/admin/_components/filter-bar";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import {
  SegmentRuleBuilder,
  isBuilderTreeValid,
} from "@/app/admin/marketing/segments/segment-builder";
import type { RuleNode } from "@/lib/promotions/rule-tree";

export type SegmentOption = { id: string; name: string };
type AudienceCount = { count: number; capped: boolean; cap: number; failed?: boolean };
const AUDIENCE_FAILED_MESSAGE = "Impossible de calculer l'audience — réessayez.";
export type CampaignView = {
  id: string;
  name: string | null;
  subject: string;
  audienceKind: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  createdAt: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Brouillon",
  queued: "En file",
  sending: "En cours",
  sent: "Envoyée",
  failed: "Échouée",
};

const AUDIENCE_LABEL: Record<string, string> = {
  marketing_optin: "Tous les clients opt-in",
  newsletter: "Abonnés newsletter",
  segment: "Segment enregistré",
  rule: "Ciblage avancé (règle)",
  addresses: "Liste d'adresses",
};

/** A fresh inline-rule tree seeds with one empty AND group — the operator must add
 *  at least one condition (send stays disabled until the rule is valid). */
const EMPTY_RULE: RuleNode = { op: "and", children: [] };

export function CampaignsTab({
  segments,
  campaigns,
  canCreate,
}: {
  segments: SegmentOption[];
  campaigns: CampaignView[];
  canCreate: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<ActionState | null>(null);
  const [audience, setAudience] = useState("marketing_optin");
  // Inline compound audience rule (audience === "rule") — the SAME builder +
  // engine promotions use, so a blast can target spend / orders /
  // life-events ad-hoc. Carried to the server as a hidden JSON field.
  const [rule, setRule] = useState<RuleNode>(EMPTY_RULE);
  const ruleValid = isBuilderTreeValid(rule);
  const [count, setCount] = useState<AudienceCount | null>(null);
  const [counting, startCount] = useTransition();
  // A send is irreversible (up to AUDIENCE_CAP customers): submitting first
  // resolves the REAL recipient count, then asks for an explicit confirmation
  // showing it (and a truncation warning at the cap) before anything is queued.
  const [preparing, startPrepare] = useTransition();
  const [confirm, setConfirm] = useState<(AudienceCount & { fd: FormData; subject: string }) | null>(
    null,
  );

  return (
    <div className="space-y-5">
      <AdminNote>
        Composez un email et envoyez-le à une audience. L&apos;envoi est progressif (file
        d&apos;attente + throttling) ; chaque message respecte le consentement marketing et inclut un
        lien de désabonnement. Les emails transactionnels ne sont pas concernés.
      </AdminNote>

      {!canCreate && (
        <AdminCallout tone="info" icon={Info}>
          Vous avez un accès en lecture seule aux campagnes. La création et l&apos;envoi
          nécessitent la permission « créer » (system_mail).
        </AdminCallout>
      )}

      {canCreate && (
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          setState(null);
          startPrepare(async () => {
            const res = await previewAudienceCountAction(fd);
            // A failed read is an UNKNOWN count, not an empty audience.
            if (res.failed) {
              setCount(null);
              setState({ ok: false, error: "internal", message: AUDIENCE_FAILED_MESSAGE });
              return;
            }
            setCount(res);
            if (res.count === 0) {
              setState({
                ok: false,
                error: "validation",
                message: "Aucun destinataire éligible pour cette audience.",
              });
              return;
            }
            setConfirm({ ...res, fd, subject: String(fd.get("subject") ?? "") });
          });
        }}
        className="space-y-4 rounded-[28px] border border-border bg-card p-5 sm:p-6"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="name" label="Nom interne (optionnel)" placeholder="Soldes d'été" />
          <SelectField
            label="Audience"
            name="audienceKind"
            value={audience}
            onChange={(v) => {
              setAudience(v);
              setCount(null);
            }}
            options={[
              { value: "marketing_optin", label: "Tous les clients opt-in" },
              { value: "newsletter", label: "Abonnés newsletter" },
              { value: "segment", label: "Segment enregistré" },
              { value: "rule", label: "Ciblage avancé (règle)" },
              { value: "addresses", label: "Liste d'adresses collée" },
            ]}
          />
        </div>

        {audience === "segment" && (
          <div>
            <SelectField
              label="Segment"
              name="segmentId"
              defaultValue={segments[0]?.id ?? ""}
              options={
                segments.length
                  ? segments.map((s) => ({ value: s.id, label: s.name }))
                  : [{ value: "", label: "Aucun segment enregistré" }]
              }
            />
            <AdminNote className="mt-1">
              Segments créés dans Marketing → Segments (manuels ou dynamiques). Un segment
              dynamique est recalculé à l&apos;envoi, comme pour les promotions.
            </AdminNote>
          </div>
        )}

        {audience === "rule" && (
          <div className="space-y-2">
            <Label>Règle de ciblage</Label>
            <AdminNote>
              Composez une audience à la volée — dépenses, nombre de commandes, anniversaire,
              démographie… C&apos;est le même
              moteur que les promotions : les clients ciblés ici sont exactement ceux qui
              seraient éligibles au même ciblage sur une promotion. Seuls les clients opt-in
              marketing reçoivent l&apos;email.
            </AdminNote>
            <SegmentRuleBuilder value={rule} onChange={setRule} />
            {/* Carried to the server; parsed + re-validated there. */}
            <input type="hidden" name="ruleTree" value={JSON.stringify(rule)} readOnly />
          </div>
        )}

        {audience === "addresses" && (
          <div>
            <Label>Adresses (une par ligne ou séparées par des virgules)</Label>
            <textarea
              name="addresses"
              rows={4}
              placeholder="client1@example.tn&#10;client2@example.tn"
              className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 font-mono text-xs focus:outline-none focus:border-foreground focus:bg-white"
            />
          </div>
        )}

        <Field name="subject" label="Objet" placeholder="Une surprise vous attend 🎁" required />
        <div>
          <Label>Corps (HTML)</Label>
          <textarea
            name="body"
            rows={10}
            required
            spellCheck={false}
            placeholder="<p>Bonjour,</p><p>…</p>"
            className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 font-mono text-[12px] leading-relaxed focus:outline-none focus:border-foreground focus:bg-white"
          />
          <AdminNote className="mt-1">
            Votre HTML est habillé automatiquement du logo, du pied de page et du lien de
            désabonnement Tokyo Store. Le même contenu est envoyé à chaque destinataire :
            aucune variable personnalisée (prénom, etc.) n&apos;est disponible.
          </AdminNote>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={preparing || (audience === "rule" && !ruleValid)}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Envoyer la campagne…
          </button>
          <button
            type="button"
            disabled={counting || (audience === "rule" && !ruleValid)}
            onClick={(e) => {
              const form = (e.currentTarget.closest("form") as HTMLFormElement) ?? null;
              if (!form) return;
              const fd = new FormData(form);
              startCount(async () => {
                setCount(await previewAudienceCountAction(fd));
              });
            }}
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface disabled:opacity-60"
          >
            {counting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
            Estimer l&apos;audience
          </button>
          {count?.failed ? (
            <span className="text-xs font-medium text-destructive">{AUDIENCE_FAILED_MESSAGE}</span>
          ) : count !== null && (
            <span className="text-xs font-medium text-muted-foreground">
              {count.count} destinataire{count.count === 1 ? "" : "s"} éligible
              {count.count === 1 ? "" : "s"}
              {count.capped && (
                <span className="text-[#b45309]">
                  {" "}
                  — limite de {count.cap} atteinte, audience tronquée
                </span>
              )}
            </span>
          )}
          {state?.message && (
            <span className={`text-xs font-medium ${state.ok ? "text-[#15803d]" : "text-destructive"}`}>
              {state.message}
            </span>
          )}
        </div>
      </form>
      )}

      {confirm && (
        <ConfirmDeleteModal
          variant="neutral"
          icon={Send}
          title={`Envoyer la campagne à ${confirm.count} destinataire${confirm.count === 1 ? "" : "s"} ?`}
          description={`« ${confirm.subject} » sera mis en file puis envoyé progressivement. Un envoi lancé ne peut pas être annulé.`}
          preview={
            confirm.capped ? (
              <AdminCallout tone="warning" icon={AlertTriangle}>
                La limite de {confirm.cap} destinataires par envoi est atteinte : l&apos;audience
                est tronquée et une partie des destinataires éligibles ne recevra pas cet email.
              </AdminCallout>
            ) : undefined
          }
          confirmLabel="Envoyer"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await createAndSendCampaignAction(null, confirm.fd);
            if (!res.ok) return res.message;
            setState(res);
            formRef.current?.reset();
            setCount(null);
            setRule(EMPTY_RULE);
            return null;
          }}
        />
      )}

      {campaigns.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[15px] font-black text-foreground">Campagnes récentes</h3>
          <div className="overflow-hidden rounded-[22px] border border-border bg-card">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#fbf9f8] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <tr>
                  <th className="px-4 py-3">Objet</th>
                  <th className="px-4 py-3">Audience</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3">Progression</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-[#fffbfb]">
                    <td className="px-4 py-3 text-foreground">{c.name || c.subject}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {AUDIENCE_LABEL[c.audienceKind] ?? c.audienceKind}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {STATUS_LABEL[c.status] ?? c.status}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="text-[#15803d]">{c.sent}</span>
                      {" / "}
                      <span>{c.total}</span>
                      {c.failed > 0 && <span className="text-destructive"> · {c.failed} échec{c.failed === 1 ? "" : "s"}</span>}
                      {c.pending > 0 && <span className="text-muted-foreground"> · {c.pending} en file</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(c.createdAt).toLocaleDateString("fr-FR", { dateStyle: "short" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[13px] font-bold text-foreground">
      {children}
    </span>
  );
}

function Field({
  name,
  label,
  placeholder,
  required,
}: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        name={name}
        required={required}
        placeholder={placeholder}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:outline-none focus:border-foreground focus:bg-white"
      />
    </label>
  );
}
