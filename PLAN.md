# Tokyo Store — Architecture & Roadmap (historical)

> **Status: complete.** Every phase of this roadmap has shipped as of
> 2026-06-10. The file is kept as a historical marker — the architecture it
> planned is now simply how the codebase works. The full original plan lives
> in git history.

What shipped:

- **Phases 1–3** — foundation (Postgres + Drizzle + Better Auth + the modular-monolith skeleton), catalog, CMS (relational page builder, navigation, banners, FAQ, blog, aid center), media hub, and DB performance hardening.
- **The feature waves that followed** — cart/checkout/orders, the payments rework (Konnect + ClicToPay + Flouci + COD), delivery and tax engines, points-based loyalty, reviews + wishlist, promotions, serial/warranty tracking, the SEO module, first-class guest orders, data retention, and the squashed migration baseline.

Where to look now:

- Current architecture and feature set: [README.md](README.md)
- Day-to-day development reference: [DEVELOPMENT.md](DEVELOPMENT.md)
- Module pattern (still the canonical spec): [docs/modules.md](docs/modules.md)
- Database architecture: [docs/database.md](docs/database.md)
- Conventions and operational requirements: [REQUIREMENTS.md](REQUIREMENTS.md)

Future plans are tracked outside the repo; nothing in this file is a live commitment.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).
