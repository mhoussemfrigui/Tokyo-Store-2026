import { RETENTION_TARGETS_TEXT } from "@/lib/retention/windows";

/**
 * Registry of SCHEDULED / CRON jobs surfaced in the admin "Tâches planifiées"
 * dashboard. Plain data (its only import is the pure retention inventory) so
 * both the server page and the client panel can read it. Adding a future job
 * (e.g. mailing digests) = append an entry here, have the job log runs via
 * `jobRunLogService.runAndLog(key, …)`, and (if `runnable`/`controllable`) wire
 * it in `src/lib/actions/jobs.ts`.
 *
 * `type`:
 *   - "internal" → an in-app timer (instrumentation.ts) the app fully owns.
 *   - "external" → driven by the single dispatch heartbeat (or an external
 *     scheduler hitting a CRON_SECRET endpoint); the app can still "run now" + log
 *     it (a manual run never needs CRON_SECRET).
 *
 * `dispatch` is the MACHINE cadence the single `/api/cron/dispatch` heartbeat reads
 * to decide which external jobs are DUE this tick (pure math in
 * `src/lib/jobs/dispatch-schedule.ts`). One Coolify Scheduled Task hits the
 * heartbeat every ~2 min and it runs each job only when its own cadence is due —
 * replacing one Coolify cron per job. `defaultSchedule` is the HUMAN label the
 * dashboard shows and must be kept in step with `dispatch` by hand.
 */
export type DispatchCadence =
  | { mode: "interval"; everyMinutes: number }
  | { mode: "daily"; atHour: number; atMinute: number }
  /** Runs off traffic / its own timer — the heartbeat never dispatches it. */
  | { mode: "opportunistic" }
  | { mode: "internal" };

export type ScheduledJobKey =
  | "retention_purge"
  | "mailing_queue"
  | "birthday_email"
  | "wishlist_campaign_email"
  | "review_request"
  | "payment_reconcile"
  | "abandoned_orders"
  | "webhook_dispatch"
  | "product_detourage"
  | "promotion_announce_sweep";

export type ScheduledJobDef = {
  key: ScheduledJobKey;
  label: string;
  description: string;
  type: "internal" | "external";
  /** Machine cadence the dispatch heartbeat schedules against. */
  dispatch: DispatchCadence;
  /** Human cadence shown when the job carries no dynamic schedule state. */
  defaultSchedule: string;
  /** Domain page that owns this job's detailed config (cadence/scope/…). */
  configHref?: string;
  /** Whether the dashboard can toggle the job enabled/disabled. */
  controllable: boolean;
  /** Whether the dashboard can trigger an immediate run. */
  runnable: boolean;
  /** A "Run now" that deletes/mutates data — the UI requires a strong confirm. */
  destructive?: boolean;
};

export const SCHEDULED_JOBS: ScheduledJobDef[] = [
  {
    key: "retention_purge",
    label: "Purge des données (rétention)",
    // Derived from the purge inventory so the listed targets can't drift from
    // what runRetentionPurge actually deletes.
    description: `Supprime les données expirées au-delà de leur fenêtre de rétention (${RETENTION_TARGETS_TEXT}). Déclenché par un cron externe (Coolify).`,
    type: "external",
    dispatch: { mode: "daily", atHour: 3, atMinute: 0 },
    defaultSchedule: "Quotidien à 03:00 (cron externe)",
    runnable: true,
    controllable: true,
    destructive: true,
  },
  {
    key: "mailing_queue",
    label: "File d'envoi des emails",
    description:
      "Vide la file d'attente des emails (campagnes + automatisations en masse) avec throttling et reprise sur erreur. Déclenché par un cron externe (Coolify) toutes les ~2 min.",
    type: "external",
    dispatch: { mode: "interval", everyMinutes: 2 },
    defaultSchedule: "Toutes les ~2 min (cron externe)",
    configHref: "/admin/marketing/mailing",
    runnable: true,
    controllable: true,
  },
  {
    key: "birthday_email",
    label: "Emails d'anniversaire",
    description:
      "Envoie chaque jour un email cadeau aux clients dont c'est l'anniversaire (code promo configuré). Déclenché par un cron externe (Coolify) une fois par jour.",
    type: "external",
    dispatch: { mode: "daily", atHour: 0, atMinute: 10 },
    defaultSchedule: "Quotidien à 00:10 (cron externe)",
    configHref: "/admin/marketing/mailing",
    runnable: true,
    controllable: true,
  },
  {
    key: "wishlist_campaign_email",
    label: "Campagne liste d'envies (personnalisée)",
    description:
      "Envoie chaque jour un code promo personnalisé (avec les articles favoris du client) aux membres opt-in du segment configuré ayant une liste d'envies — p. ex. à l'approche d'un anniversaire. Déclenché par un cron externe une fois par jour.",
    type: "external",
    dispatch: { mode: "daily", atHour: 0, atMinute: 20 },
    defaultSchedule: "Quotidien à 00:20 (cron externe)",
    configHref: "/admin/marketing/mailing",
    runnable: true,
    controllable: true,
  },
  {
    key: "promotion_announce_sweep",
    label: "Annonces de promotions programmées",
    description:
      "Envoie les annonces de promotions par email à l'heure programmée (champ « Annoncer par email le » de la promotion), une fois chacune. Vérifié toutes les ~5 min par un cron externe car l'heure d'annonce est arbitraire (une cadence quotidienne retarderait une annonce de 14h30 jusqu'au lendemain).",
    type: "external",
    dispatch: { mode: "interval", everyMinutes: 5 },
    defaultSchedule: "Toutes les ~5 min (cron externe)",
    configHref: "/admin/promotions",
    runnable: true,
    controllable: true,
  },
  {
    key: "review_request",
    label: "Demandes d'avis",
    description:
      "Invite les clients à laisser un avis quelques jours après la livraison de leur commande. Déclenché par un cron externe (Coolify) une fois par jour.",
    type: "external",
    dispatch: { mode: "daily", atHour: 9, atMinute: 30 },
    defaultSchedule: "Quotidien à 09:30 (cron externe)",
    configHref: "/admin/marketing/mailing",
    runnable: true,
    controllable: true,
  },
  {
    key: "payment_reconcile",
    label: "Réconciliation des paiements",
    description:
      "Rattrape les commandes en ligne bloquées en « en attente » (onglet de retour fermé sur ClicToPay/Flouci, ou crash entre la réservation webhook et la transition) : re-vérifie le paiement auprès de la passerelle et règle la commande. Déclenché par un cron externe (Coolify) toutes les ~12 min.",
    type: "external",
    dispatch: { mode: "interval", everyMinutes: 12 },
    defaultSchedule: "Toutes les ~12 min (cron externe)",
    runnable: true,
    controllable: true,
  },
  {
    key: "abandoned_orders",
    label: "Commandes abandonnées (stock)",
    description:
      "Annule les commandes restées « en attente » au-delà de la fenêtre d'abandon (48 h par défaut, ABANDONED_ORDER_HOURS) et restitue le stock réservé à la création. Couvre le COD non confirmé, les commandes en ligne sans référence de paiement, et celles sorties de la fenêtre de réconciliation. N'annule jamais une commande confirmée par un opérateur, une commande poussée par l'ERP, ni une vente en boutique sans point de retrait réglée hors ligne (ex. caisse « Non payé »). Un retrait (drive / magasin) sur un point choisi et non confirmé est annulé comme un COD à domicile. Déclenché par un cron externe (Coolify) ~toutes les heures.",
    type: "external",
    dispatch: { mode: "interval", everyMinutes: 60 },
    defaultSchedule: "Toutes les ~60 min (cron externe)",
    runnable: true,
    controllable: true,
  },
  {
    key: "webhook_dispatch",
    label: "Webhooks sortants (ERP)",
    description:
      "Livre les webhooks sortants en file d'attente vers les endpoints ERP abonnés : POST JSON signé (HMAC), avec reprise sur erreur et back-off. Déclenché par un cron externe (Coolify) toutes les ~2 min.",
    type: "external",
    dispatch: { mode: "interval", everyMinutes: 2 },
    defaultSchedule: "Toutes les ~2 min (cron externe)",
    configHref: "/admin/system/api?tab=webhooks-out",
    runnable: true,
    controllable: true,
  },
  {
    key: "product_detourage",
    label: "Détourage des images produits",
    description:
      "Détoure (retire le fond uni → transparent) les images produits existantes qui ne l'ont pas encore été — un rattrapage des imports / anciens uploads. Ne s'exécute QUE si le détourage automatique est activé (réglage « Détourage automatique du fond uni », Médiathèque → Réglages) ; sinon la tâche est ignorée. Idempotent (une image déjà en `-nobg` est sautée), donc une cadence quotidienne ne re-traite que les nouvelles images. Irréversible : les anciens objets sont remplacés puis supprimés (les vignettes de commandes historiques sont préservées). Déclenché par un cron externe (Coolify).",
    type: "external",
    dispatch: { mode: "daily", atHour: 4, atMinute: 0 },
    defaultSchedule: "Quotidien à 04:00 (cron externe)",
    configHref: "/admin/media/settings",
    runnable: true,
    controllable: true,
    destructive: true,
  },
];

export function getScheduledJob(key: string): ScheduledJobDef | undefined {
  return SCHEDULED_JOBS.find((j) => j.key === key);
}
