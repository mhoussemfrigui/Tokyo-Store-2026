/**
 * PURE security-posture model — NO "server-only", NO DB import, so it can be
 * unit-tested directly (mirrors src/lib/telemetry/perf-config.ts +
 * src/events/severity.ts). Turns a flat bag of resolved security FACTS (which the
 * Sécurité page gathers from headers/env/live signals) into an OWASP-aligned
 * checklist + an overall score, so the admin sees ONE at-a-glance posture instead
 * of reading six diagnostic cards. Changing a control's status here never touches
 * the enforcement — this is a read-only mirror of what is actually configured.
 */

/** A single posture line. `status`: pass = control active; warn = a real gap to
 *  close; info = acceptable / context-dependent (no action mandated). */
export type PostureStatus = "pass" | "warn" | "info";

export type PostureItem = {
  id: string;
  /** OWASP 2021 category tag, e.g. "A05". */
  owasp: string;
  label: string;
  status: PostureStatus;
  detail: string;
};

/** The resolved facts the posture is computed from (all serialisable). */
export type PostureFacts = {
  isProd: boolean;
  /** BETTER_AUTH_SECRET present, ≥32 chars, non-placeholder. */
  authSecretValid: boolean;
  /** PAYMENT_ENCRYPTION_KEY present (payment creds stored encrypted). */
  paymentEncryptionConfigured: boolean;
  /** The active PAYMENT_ENCRYPTION_KEY is stored in `app_secrets` in THIS SAME DB
   *  (auto-generated on boot) rather than supplied out-of-band via the environment.
   *  When true, a DB dump / backup leak contains BOTH the key and the ciphertext it
   *  protects, so at-rest encryption gives no protection against its primary threat —
   *  the posture must NOT report a plain "pass". */
  paymentKeyFromDb: boolean;
  /** DB TLS: true = verified (CA pinned), false = required-but-unverified,
   *  null = TLS not required (localhost / private network). */
  dbTlsVerified: boolean | null;
  /** CSP emits a per-request nonce (vs relying on 'unsafe-inline'). */
  cspHasNonce: boolean;
  /** CSP locks object-src/base-uri/frame-ancestors/form-action. */
  cspStrictDirectives: boolean;
  /** HSTS (Strict-Transport-Security) served. */
  hsts: boolean;
  /** Opt-in TOTP 2FA is available to all accounts. */
  twoFactorAvailable: boolean;
  /** Whether the 2FA-adoption signal actually loaded (false ⇒ DB degraded, so
   *  `adminsWithout2fa` is unknown — the control reports info, not a false pass). */
  twoFactorDataAvailable: boolean;
  /** Active admins with NO 2FA enrolment (the high-value gap). */
  adminsWithout2fa: number;
  /** Brute-force throttling on the credential endpoints. */
  bruteForceThrottling: boolean;
  /** Last-admin floor (can't disable/delete the final admin). */
  lastAdminFloor: boolean;
  /** Security-failure events are recorded (the attack trail). */
  securityEventLogging: boolean;
  /** Email verification required before first session. */
  emailVerificationRequired: boolean;
};

export function computePosture(f: PostureFacts): {
  items: PostureItem[];
  summary: { pass: number; warn: number; info: number; total: number; scorePct: number };
} {
  const items: PostureItem[] = [];
  const add = (id: string, owasp: string, label: string, status: PostureStatus, detail: string) =>
    items.push({ id, owasp, label, status, detail });

  add(
    "hsts",
    "A05",
    "HSTS (HTTP Strict Transport Security)",
    f.hsts ? "pass" : "warn",
    f.hsts
      ? "En-tête servi (max-age 2 ans, includeSubDomains, preload)."
      : "En-tête HSTS absent — le trafic peut être rétrogradé en HTTP.",
  );
  add(
    "csp-strict",
    "A05",
    "CSP — directives verrouillées",
    f.cspStrictDirectives ? "pass" : "warn",
    f.cspStrictDirectives
      ? "object-src 'none', base-uri/form-action/frame-ancestors 'self'."
      : "Directives CSP de base manquantes.",
  );
  add(
    "csp-nonce",
    "A03",
    "CSP — script-src avec nonce",
    f.cspHasNonce ? "pass" : "warn",
    f.cspHasNonce
      ? "script-src utilise un nonce par requête (pas de 'unsafe-inline')."
      : "script-src repose sur 'unsafe-inline' (hydratation RSC). Filet anti-XSS limité ; migration nonce + strict-dynamic à planifier. La désinfection HTML (DOMPurify) reste le contrôle actif.",
  );
  add(
    "auth-secret",
    "A02",
    "Secret d'authentification",
    f.authSecretValid ? "pass" : "warn",
    f.authSecretValid
      ? "BETTER_AUTH_SECRET défini, ≥ 32 caractères, non générique."
      : "BETTER_AUTH_SECRET absent, trop court ou générique.",
  );
  add(
    "payment-enc",
    "A02",
    "Chiffrement des identifiants de paiement",
    !f.paymentEncryptionConfigured ? "warn" : f.paymentKeyFromDb ? "warn" : "pass",
    !f.paymentEncryptionConfigured
      ? "PAYMENT_ENCRYPTION_KEY absent — configurez-le avant de saisir des identifiants passerelle."
      : f.paymentKeyFromDb
        ? "PAYMENT_ENCRYPTION_KEY auto-généré et stocké en base (app_secrets), dans la MÊME base que les identifiants chiffrés : une fuite de dump/sauvegarde contiendrait la clé ET le chiffré, donc le chiffrement au repos ne protège pas contre sa menace principale. Fournissez la clé via l'environnement pour un vrai chiffrement au repos."
        : "PAYMENT_ENCRYPTION_KEY fourni via l'environnement (hors base) — les identifiants passerelle sont chiffrés au repos.",
  );
  add(
    "db-tls",
    "A02",
    "TLS base de données vérifié",
    f.dbTlsVerified === true ? "pass" : f.dbTlsVerified === null ? "info" : "warn",
    f.dbTlsVerified === true
      ? "Connexion chiffrée + certificat vérifié (DB_SSL_CA)."
      : f.dbTlsVerified === null
        ? "TLS non requis (réseau privé / localhost) — pas de MITM applicable."
        : "sslmode=require sans DB_SSL_CA : chiffré mais certificat NON vérifié.",
  );
  add(
    "2fa",
    "A07",
    "Double authentification (TOTP)",
    !f.twoFactorAvailable
      ? "warn"
      : !f.twoFactorDataAvailable
        ? "info"
        : f.adminsWithout2fa === 0
          ? "pass"
          : "warn",
    !f.twoFactorAvailable
      ? "La 2FA n'est pas disponible."
      : !f.twoFactorDataAvailable
        ? "2FA disponible, mais l'adoption (admins sans 2FA) est momentanément indisponible (base inaccessible)."
        : f.adminsWithout2fa > 0
          ? `2FA disponible, mais ${f.adminsWithout2fa} administrateur(s) actif(s) sans 2FA — activez-la sur ces comptes.`
          : "2FA disponible et tous les administrateurs actifs l'ont activée.",
  );
  add(
    "brute-force",
    "A07",
    "Limitation anti-force-brute",
    f.bruteForceThrottling ? "pass" : "warn",
    f.bruteForceThrottling
      ? "Connexion / inscription / 2FA limitées par IP + par compte/défi (Postgres)."
      : "Aucune limitation de débit sur les points d'authentification.",
  );
  add(
    "email-verif",
    "A07",
    "Vérification e-mail obligatoire",
    f.emailVerificationRequired ? "pass" : "info",
    f.emailVerificationRequired
      ? "Aucune session avant la confirmation de l'adresse e-mail."
      : "La vérification e-mail n'est pas exigée avant la première session.",
  );
  add(
    "last-admin",
    "A01",
    "Protection du dernier administrateur",
    f.lastAdminFloor ? "pass" : "warn",
    f.lastAdminFloor
      ? "Impossible de désactiver / supprimer le dernier administrateur actif."
      : "Le dernier administrateur peut être supprimé — risque de verrouillage.",
  );
  add(
    "sec-logging",
    "A09",
    "Journalisation des échecs de sécurité",
    f.securityEventLogging ? "pass" : "warn",
    f.securityEventLogging
      ? "Échecs de connexion / 2FA / limitation / refus RBAC / clé API enregistrés."
      : "Les échecs d'authentification ne laissent aucune trace (angle mort).",
  );

  const pass = items.filter((i) => i.status === "pass").length;
  const warn = items.filter((i) => i.status === "warn").length;
  const info = items.filter((i) => i.status === "info").length;
  const total = items.length;
  // Score = passing controls / scoreable controls (info items are neutral —
  // excluded from the denominator so an acceptable "TLS not required" doesn't
  // drag the score down).
  const scoreable = total - info;
  const scorePct = scoreable > 0 ? Math.round((pass / scoreable) * 100) : 100;
  return { items, summary: { pass, warn, info, total, scorePct } };
}
