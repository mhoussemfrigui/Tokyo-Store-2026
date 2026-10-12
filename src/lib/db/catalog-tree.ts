/**
 * Canonical catalog taxonomy — the SINGLE source of truth for
 * `pnpm db:seed:catalog` (src/lib/db/seed-catalog.ts), the one-click
 * "Import démo" flow (src/workflows/demo/import-demo.ts) AND the product
 * importer's category mapper (src/lib/import/category-map.ts).
 *
 * This is the Tokyo Store HIGH-TECH taxonomy, derived from the migration feed
 * (`Tokyo Store Migration Data/tokyostore.xml` → `cmp:canonical_category_path`)
 * and kept in lock-step with the live category tree: 8 universes (Univers Apple,
 * Téléphonie, Console Gaming, PC Gaming, Audiovisuel, Univers Tokyo Store, Objets
 * Connectés, Cartes-cadeaux et Abonnements) nesting sections → items.
 *
 * Slugs are globally unique (the storefront resolves categories at the flat
 * `/[slug]` namespace) and match the feed-built slugs, so imported products map
 * onto the right node and existing links keep resolving. The tree is RECURSIVE —
 * `children` nest arbitrarily; sibling order in the array IS the display_order.
 *
 * Regenerate after a taxonomy change by rebuilding from the feed
 * (`scripts/tokyo-build-categories.ts`) then dumping the live tree.
 *
 * Pure data only (no DB client import) so it's safe to import from the
 * CLI seed script, the in-app workflow and client-adjacent code alike.
 */

export type CatalogNode = {
  slug: string;
  name: string;
  tagline?: string;
  children?: CatalogNode[];
};

export const CATALOG_TREE: CatalogNode[] = [
  {
    slug: "audiovisuel",
    name: "Audiovisuel",
    children: [
      {
        slug: "lumiere",
        name: "Lumière",
      },
      {
        slug: "photo",
        name: "Photo",
      },
      {
        slug: "son",
        name: "Son",
        children: [
          {
            slug: "accessoires-audio",
            name: "Accessoires Audio",
          },
          {
            slug: "casques",
            name: "Casques",
          },
          {
            slug: "ecouteurs",
            name: "Écouteurs",
          },
          {
            slug: "enceintes",
            name: "Enceintes",
          },
          {
            slug: "microphones",
            name: "Microphones",
          },
        ],
      },
    ],
  },
  {
    slug: "cartes-cadeaux-et-abonnements",
    name: "Cartes-cadeaux et Abonnements",
    children: [
      {
        slug: "abonnements",
        name: "Abonnements",
        children: [
          {
            slug: "netflix",
            name: "Netflix",
          },
        ],
      },
      {
        slug: "recharge",
        name: "Recharge",
        children: [
          {
            slug: "apple",
            name: "Apple",
            children: [
              {
                slug: "itunes",
                name: "Itunes",
              },
            ],
          },
          {
            slug: "console",
            name: "Console",
            children: [
              {
                slug: "cartes-xbox",
                name: "Cartes Xbox",
              },
              {
                slug: "nintendo-switch-eshop",
                name: "Nintendo Switch Eshop",
              },
              {
                slug: "playstation-network-psn",
                name: "PlayStation Network (PSN)",
              },
            ],
          },
          {
            slug: "divertissements",
            name: "Divertissements",
            children: [
              {
                slug: "amazon",
                name: "Amazon",
              },
              {
                slug: "paysafe",
                name: "Paysafe",
              },
            ],
          },
          {
            slug: "jeux-video",
            name: "Jeux Video",
            children: [
              {
                slug: "fortnite-v-bucks",
                name: "Fortnite V-Bucks",
              },
              {
                slug: "free-fire",
                name: "Free Fire",
              },
              {
                slug: "league-of-legends-lol",
                name: "League Of Legends (LOL)",
              },
              {
                slug: "pubg",
                name: "PUBG",
              },
              {
                slug: "roblox",
                name: "Roblox",
              },
              {
                slug: "steam",
                name: "Steam",
              },
              {
                slug: "valorant",
                name: "Valorant",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "console-gaming",
    name: "Console Gaming",
    children: [
      {
        slug: "accessoires-pour-consoles",
        name: "Accessoires pour Consoles",
        children: [
          {
            slug: "accessoires-nintendo",
            name: "Accessoires Nintendo",
            children: [
              {
                slug: "joy-con-paire-de-manette-vert",
                name: "Joy Con : Paire de Manette - Vert",
                children: [
                  {
                    slug: "rose",
                    name: "Rose",
                  },
                ],
              },
              {
                slug: "joy-con-paire-de-manette-violet",
                name: "Joy Con : Paire de Manette - Violet",
                children: [
                  {
                    slug: "bleu",
                    name: "Bleu",
                  },
                ],
              },
              {
                slug: "joy-con-paire-de-manettes-bleu",
                name: "Joy Con : Paire de Manettes - Bleu",
                children: [
                  {
                    slug: "rouge",
                    name: "Rouge",
                  },
                ],
              },
            ],
          },
          {
            slug: "accessoires-playstation-4",
            name: "Accessoires PlayStation 4",
          },
          {
            slug: "accessoires-playstation-5",
            name: "Accessoires PlayStation 5",
          },
          {
            slug: "accessoires-xbox",
            name: "Accessoires Xbox",
          },
        ],
      },
      {
        slug: "consoles",
        name: "Consoles",
        children: [
          {
            slug: "consoles-portable",
            name: "Consoles Portable",
          },
          {
            slug: "nintendo-switch",
            name: "Nintendo Switch",
          },
          {
            slug: "nintendo-switch-2",
            name: "Nintendo Switch 2",
          },
          {
            slug: "playstation-4",
            name: "PlayStation 4",
          },
          {
            slug: "playstation-5",
            name: "PlayStation 5",
          },
        ],
      },
      {
        slug: "jeux-console",
        name: "Jeux Console",
        children: [
          {
            slug: "jeux-ps4",
            name: "Jeux PS4",
          },
          {
            slug: "jeux-ps5",
            name: "Jeux PS5",
          },
          {
            slug: "jeux-switch",
            name: "Jeux Switch",
          },
          {
            slug: "jeux-xbox",
            name: "Jeux Xbox",
          },
        ],
      },
    ],
  },
  {
    slug: "objets-connectes",
    name: "Objets Connectés",
    children: [
      {
        slug: "smartwatch-et-accessoires",
        name: "Smartwatch et Accessoires",
        children: [
          {
            slug: "accessoires-smartwatch",
            name: "Accessoires Smartwatch",
          },
          {
            slug: "montres-connectees",
            name: "Montres connectées",
          },
        ],
      },
    ],
  },
  {
    slug: "pc-gaming",
    name: "PC Gaming",
    children: [
      {
        slug: "accessoires-et-peripheriques",
        name: "Accessoires et Périphériques",
        children: [
          {
            slug: "casques-et-micro-gaming",
            name: "Casques et Micro Gaming",
          },
          {
            slug: "clavier-gaming",
            name: "Clavier Gaming",
          },
          {
            slug: "divers-accessoires-et-peripheriques",
            name: "Divers",
          },
          {
            slug: "souris",
            name: "Souris",
          },
          {
            slug: "souris-gaming",
            name: "Souris Gaming",
          },
          {
            slug: "tapis-gaming",
            name: "Tapis Gaming",
          },
        ],
      },
      {
        slug: "jeux-pc",
        name: "Jeux PC",
      },
      {
        slug: "pack-accesoires",
        name: "Pack Accesoires",
      },
    ],
  },
  {
    slug: "telephonie",
    name: "Téléphonie",
    children: [
      {
        slug: "accessoires-telephoniques",
        name: "Accessoires Téléphoniques",
        children: [
          {
            slug: "accessoires-voiture",
            name: "Accessoires Voiture",
          },
          {
            slug: "alimentation-et-cables",
            name: "Alimentation et Câbles",
            children: [
              {
                slug: "cable",
                name: "Cable",
              },
              {
                slug: "chargeurs-et-adaptateurs",
                name: "Chargeurs et Adaptateurs",
              },
              {
                slug: "power-bank",
                name: "Power Bank",
              },
            ],
          },
          {
            slug: "coques-et-etuis",
            name: "Coques et Etuis",
          },
          {
            slug: "divers-telephonie",
            name: "Divers Téléphonie",
          },
          {
            slug: "protection",
            name: "Protection",
          },
          {
            slug: "son-accessoires-telephoniques",
            name: "Son",
            children: [
              {
                slug: "ecouteurs-son",
                name: "Écouteurs",
              },
              {
                slug: "haut-parleur",
                name: "Haut-Parleur",
              },
            ],
          },
        ],
      },
      {
        slug: "smartphone",
        name: "Smartphone",
      },
      {
        slug: "tablette",
        name: "Tablette",
        children: [
          {
            slug: "etui-galaxy-tab-s8",
            name: "Étui Galaxy Tab S8+",
            children: [
              {
                slug: "s7-book-cover-noir-samsung",
                name: "S7+ Book Cover Noir - Samsung",
              },
            ],
          },
        ],
      },
      {
        slug: "telephone-portable",
        name: "Téléphone Portable",
      },
    ],
  },
  {
    slug: "univers-apple",
    name: "Univers Apple",
    children: [
      {
        slug: "accessoires-apple",
        name: "Accessoires Apple",
        children: [
          {
            slug: "alimentation-accessoires-apple",
            name: "Alimentation",
            children: [
              {
                slug: "adaptateur",
                name: "Adaptateur",
              },
              {
                slug: "cable-alimentation",
                name: "Cable",
              },
            ],
          },
          {
            slug: "magsafe-accessoires-apple",
            name: "MagSafe",
          },
          {
            slug: "protection-accessoires-apple",
            name: "Protection",
            children: [
              {
                slug: "coques-et-etuis-protection",
                name: "Coques et Étuis",
              },
              {
                slug: "films-de-protection",
                name: "Films de protection",
                children: [
                  {
                    slug: "protection-camera-pour-iphone-14",
                    name: "Protection Camera Pour iPhone 14",
                    children: [
                      {
                        slug: "14-plus-unipro",
                        name: "14 Plus - UNIPRO",
                      },
                    ],
                  },
                  {
                    slug: "protection-camera-pour-iphone-15",
                    name: "Protection Camera Pour iPhone 15",
                    children: [
                      {
                        slug: "15-plus-unipro",
                        name: "15 Plus - UNIPRO",
                      },
                    ],
                  },
                ],
              },
              {
                slug: "protection-pour-camera",
                name: "Protection pour Caméra",
              },
            ],
          },
        ],
      },
      {
        slug: "accessoires-apple-officiels",
        name: "Accessoires Apple Officiels",
        children: [
          {
            slug: "air-tags",
            name: "Air Tags",
          },
          {
            slug: "alimentation",
            name: "Alimentation",
          },
          {
            slug: "magsafe",
            name: "MagSafe",
          },
          {
            slug: "protection-accessoires-apple-officiels",
            name: "Protection",
          },
          {
            slug: "son-accessoires-apple-officiels",
            name: "Son",
          },
        ],
      },
      {
        slug: "airpods",
        name: "Airpods",
      },
      {
        slug: "apple-watch",
        name: "Apple Watch",
      },
      {
        slug: "ipad-et-mac",
        name: "iPad et Mac",
        children: [
          {
            slug: "ipad",
            name: "iPad",
          },
          {
            slug: "mac",
            name: "Mac",
          },
        ],
      },
      {
        slug: "iphone",
        name: "iPhone",
        children: [
          {
            slug: "iphones-d-occasion",
            name: "iPhones d'occasion",
          },
          {
            slug: "iphones-neufs",
            name: "iPhones Neufs",
          },
        ],
      },
    ],
  },
  {
    slug: "univers-tokyo-store",
    name: "Univers Tokyo Store",
    children: [
      {
        slug: "divers",
        name: "Divers",
        children: [
          {
            slug: "video-stabilization-camera-bracket",
            name: "Video Stabilization Camera Bracket",
            children: [
              {
                slug: "selfie-stick-a21",
                name: "Selfie Stick A21",
              },
            ],
          },
        ],
      },
      {
        slug: "figurines",
        name: "Figurines",
        children: [
          {
            slug: "figurine-statue-trio-luffy",
            name: "Figurine Statue Trio Luffy",
            children: [
              {
                slug: "law",
                name: "Law",
                children: [
                  {
                    slug: "kid-20-cm-one-piece",
                    name: "Kid (20 cm) - One Piece",
                  },
                ],
              },
            ],
          },
          {
            slug: "figurine-statue-yami-yugi",
            name: "Figurine Statue Yami Yugi",
            children: [
              {
                slug: "atem-28-cm",
                name: "Atem (28 cm)",
              },
            ],
          },
        ],
      },
      {
        slug: "gadgets-lifestyle",
        name: "Gadgets Lifestyle",
      },
      {
        slug: "produits-tendances",
        name: "Produits Tendances",
      },
    ],
  },
];

/** Depth-first walk of the tree — `visit` receives the node, its parent (or
 *  null for roots) and its sibling index (= display_order). */
export function walkCatalogTree(
  nodes: CatalogNode[],
  visit: (node: CatalogNode, parent: CatalogNode | null, index: number) => void,
  parent: CatalogNode | null = null,
): void {
  nodes.forEach((node, index) => {
    visit(node, parent, index);
    if (node.children?.length) walkCatalogTree(node.children, visit, node);
  });
}
