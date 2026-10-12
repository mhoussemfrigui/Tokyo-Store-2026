import { RefreshCw, ShieldCheck, Truck, Wallet } from "lucide-react";

/**
 * The dark four-promise reassurance band under the listing (Normal V1), shared by
 * the category & search pages. Static store-wide promises — crimson icon tile,
 * title, sub. Ink panel (`bg-foreground`) with the page background as its text.
 */
const PROMISES = [
  { icon: Truck, title: "Livraison 24h", sub: "Partout en Tunisie" },
  { icon: ShieldCheck, title: "Garantie 12 mois", sub: "Neuf — garantie constructeur" },
  { icon: Wallet, title: "Paiement à la livraison", sub: "Ou carte bancaire" },
  { icon: RefreshCw, title: "Reprise immédiate", sub: "Estimation gratuite" },
];

export function ServiceBand() {
  return (
    <section
      aria-label="Nos services"
      className="grid gap-6 rounded-[36px] bg-foreground p-6 text-background sm:p-8 lg:p-9 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]"
    >
      {PROMISES.map((p) => (
        <div key={p.title} className="flex items-start gap-3.5">
          <span className="grid size-[46px] shrink-0 place-items-center rounded-2xl bg-primary">
            <p.icon aria-hidden className="size-5 text-primary-foreground" strokeWidth={2} />
          </span>
          <div>
            <div className="text-[17px] font-extrabold">{p.title}</div>
            <div className="mt-1 text-[14px] text-background/70">{p.sub}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
