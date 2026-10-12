"use client";

import { useActionState, useState } from "react";
import { Loader2, Save } from "lucide-react";

import {
  ProviderSettings,
  TemplateCard,
  Feedback,
  type TemplateView,
  type BrandVars,
  type SmtpView,
  type MailLocks,
  type MailHasValue,
  type MailTransportView,
} from "@/app/admin/system/mail/mailing-panel";
import { saveMailGlobalTogglesAction } from "@/lib/actions/mailing";
import { SelectField } from "@/components/ui/select-field";
import { type ActionState } from "@/lib/actions/types";
import { ToggleField, NumberField, TextField } from "@/components/admin/_components/setting-fields";
import { SubTabBar } from "@/components/admin/_components/form-tabs";
import { AdminNote } from "@/components/admin/_components/filter-bar";

import { WorkflowsTab, type FlowView } from "./workflows-tab";
import { LogsTab, type LogView } from "./logs-tab";
import { CampaignsTab, type SegmentOption, type CampaignView } from "./campaigns-tab";
import { IndividualTab } from "./individual-tab";

type SettingsProps = {
  provider: string;
  from: string;
  replyTo: string;
  smtp: SmtpView;
  sendmailPath: string;
  marketingEnabled: boolean;
  throttlePerMin: string;
  dailyLimit: string;
  dailyResetTime: string;
  reviewDelayDays: string;
  birthdayCode: string;
  wishlistCampaignCode: string;
  wishlistCampaignSegmentId: string;
  welcomeCode: string;
  locks: MailLocks;
  hasValue: MailHasValue;
  transport: MailTransportView;
};

const TABS = [
  { id: "campaigns", label: "Campagnes" },
  { id: "individual", label: "Envoi direct" },
  { id: "workflows", label: "Workflows" },
  { id: "templates", label: "Modèles" },
  { id: "logs", label: "Journaux" },
  { id: "settings", label: "Réglages" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function MailingTabs({
  settings,
  templates,
  brandVars,
  flows,
  logs,
  logCounts,
  segments,
  campaigns,
  canUpdate,
  canManage,
  canCreate,
}: {
  settings: SettingsProps;
  templates: TemplateView[];
  brandVars: BrandVars;
  flows: FlowView[];
  logs: LogView[];
  logCounts: Record<string, number>;
  segments: SegmentOption[];
  campaigns: CampaignView[];
  canUpdate: boolean;
  canManage: boolean;
  canCreate: boolean;
}) {
  const [tab, setTab] = useState<TabId>("campaigns");

  return (
    <div className="space-y-5">
      <SubTabBar tabs={TABS} activeTab={tab} onSelect={setTab} />

      {tab === "settings" && (
        <div className="space-y-6">
          <ProviderSettings
            provider={settings.provider}
            from={settings.from}
            replyTo={settings.replyTo}
            smtp={settings.smtp}
            sendmailPath={settings.sendmailPath}
            locks={settings.locks}
            hasValue={settings.hasValue}
            transport={settings.transport}
          />
          <GlobalTogglesForm
            marketingEnabled={settings.marketingEnabled}
            throttlePerMin={settings.throttlePerMin}
            dailyLimit={settings.dailyLimit}
            dailyResetTime={settings.dailyResetTime}
            reviewDelayDays={settings.reviewDelayDays}
            birthdayCode={settings.birthdayCode}
            wishlistCampaignCode={settings.wishlistCampaignCode}
            wishlistCampaignSegmentId={settings.wishlistCampaignSegmentId}
            segments={segments}
            welcomeCode={settings.welcomeCode}
            canUpdate={canUpdate}
          />
        </div>
      )}

      {tab === "templates" && (
        <div className="space-y-3">
          {templates.map((t) => (
            <TemplateCard key={t.key} t={t} brandVars={brandVars} />
          ))}
        </div>
      )}

      {tab === "workflows" && <WorkflowsTab flows={flows} canUpdate={canUpdate} />}

      {tab === "logs" && <LogsTab logs={logs} counts={logCounts} canManage={canManage} />}

      {tab === "campaigns" && (
        <CampaignsTab segments={segments} campaigns={campaigns} canCreate={canCreate} />
      )}

      {tab === "individual" && <IndividualTab canCreate={canCreate} />}
    </div>
  );
}

function GlobalTogglesForm({
  marketingEnabled,
  throttlePerMin,
  dailyLimit,
  dailyResetTime,
  reviewDelayDays,
  birthdayCode,
  wishlistCampaignCode,
  wishlistCampaignSegmentId,
  segments,
  welcomeCode,
  canUpdate,
}: {
  marketingEnabled: boolean;
  throttlePerMin: string;
  dailyLimit: string;
  dailyResetTime: string;
  reviewDelayDays: string;
  birthdayCode: string;
  wishlistCampaignCode: string;
  wishlistCampaignSegmentId: string;
  segments: SegmentOption[];
  welcomeCode: string;
  canUpdate: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveMailGlobalTogglesAction,
    null,
  );
  return (
    <form action={action} className="space-y-5 rounded-[28px] border border-border bg-card p-5 sm:p-6">
      {/* Read-only for a delegate without system_mail:update — the fieldset
          natively disables every control inside (incl. the submit). */}
      <fieldset disabled={!canUpdate} className="contents">
      <div>
        <h2 className="text-[18px] font-black text-foreground">Réglages globaux</h2>
        <AdminNote className="mt-1">
          Interrupteur général des emails marketing (les emails transactionnels — mot de passe,
          commandes — ne sont jamais concernés) et débit d&apos;envoi de la file.
        </AdminNote>
      </div>
      <ToggleField
        name="mail.marketing_enabled"
        label="Emails marketing activés"
        description="Coupe tous les emails marketing/automatisations (promos, anniversaire, baisses de prix). Les emails transactionnels continuent."
        defaultChecked={marketingEnabled}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          name="mail.throttle_per_min"
          label="Débit d'envoi (emails / minute)"
          defaultValue={throttlePerMin}
          min={1}
        />
        <NumberField
          name="mail.review_delay_days"
          label="Délai demande d'avis (jours)"
          defaultValue={reviewDelayDays}
          min={1}
        />
      </div>

      {/* Daily marketing-send cap + its reset time. */}
      <div className="rounded-[22px] border border-border bg-surface/30 p-4">
        <p className="mb-2 text-[13px] font-bold text-foreground">Limite d&apos;envoi quotidienne</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            name="mail.daily_limit"
            label="Emails marketing max / jour (0 = illimité)"
            defaultValue={dailyLimit}
            min={0}
          />
          <TextField
            name="mail.daily_reset_time"
            label="Heure de réinitialisation (HH:MM)"
            defaultValue={dailyResetTime}
            placeholder="00:00"
          />
        </div>
        <AdminNote className="mt-2">
          Plafonne les envois marketing + campagnes par jour (heure de Tunis). Une fois la
          limite atteinte, les campagnes se mettent en pause et reprennent automatiquement à
          l&apos;heure de réinitialisation. Les emails transactionnels (commandes, mots de passe…)
          ne sont jamais concernés.
        </AdminNote>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="mail.birthday_code"
          label="Code promo anniversaire"
          defaultValue={birthdayCode}
          placeholder="ANNIV20"
        />
        <TextField
          name="newsletter.welcome_code"
          label="Code de bienvenue (newsletter)"
          defaultValue={welcomeCode}
          placeholder="WELCOME10"
        />
      </div>
      <AdminNote>
        Ces codes pointent vers une promotion existante (onglet Promotions). Pour
        l&apos;anniversaire, ciblez la promo sur un segment « Anniversaire aujourd&apos;hui » pour
        qu&apos;elle ne soit utilisable que le jour J.
      </AdminNote>

      {/* Campagne personnalisée « liste d'envies » — code + segment cible. */}
      <div className="mt-2 rounded-[22px] border border-border bg-surface/30 p-4">
        <p className="mb-2 text-[13px] font-bold text-foreground">Campagne liste d&apos;envies (personnalisée)</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="mail.wishlist_campaign_code"
            label="Code promo campagne liste d'envies"
            defaultValue={wishlistCampaignCode}
            placeholder="FAVORIS20"
          />
          <SelectField
            label="Segment cible"
            name="mail.wishlist_campaign_segment_id"
            defaultValue={wishlistCampaignSegmentId}
            options={[
              { value: "", label: "— Aucun (campagne inactive) —" },
              ...segments.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </div>
        <AdminNote className="mt-2">
          Envoyée chaque jour aux membres opt-in du segment ayant une liste d&apos;envies, avec leurs
          articles favoris + ce code. Pour « près de l&apos;anniversaire », créez un segment dynamique
          (Clients → Segments) avec une règle d&apos;anniversaire. Activez le flux dans l&apos;onglet Workflows.
        </AdminNote>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer
        </button>
        <Feedback state={state} />
      </div>
      </fieldset>
    </form>
  );
}
