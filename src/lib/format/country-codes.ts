/**
 * Country dial codes for the phone input — PURE data + a split/compose pair, no
 * `server-only`, so it's importable from client components.
 *
 * Tunisia (+216) is the hard-coded default: a bare local number is ASSUMED
 * Tunisian rather than guessed. The picker shows the DIAL CODE only ("+216") —
 * no flag emoji, which degrades to raw ISO letters on Windows — with the country
 * name as each option's muted description and a search keyword. Comprehensive
 * (all countries) EXCEPT Israel; Tunisia + the region/diaspora are ordered first,
 * the rest alphabetically by French name.
 */
export type CountryDial = { iso: string; name: string; dial: string; flag?: string };

/** Default dial code (Tunisia). */
export const DEFAULT_DIAL = "216";

/** Tunisia (default) + the neighbours / common diaspora destinations, first. */
const PRIORITY: readonly CountryDial[] = [
  { iso: "TN", name: "Tunisie", dial: "216" },
  { iso: "DZ", name: "Algérie", dial: "213" },
  { iso: "LY", name: "Libye", dial: "218" },
  { iso: "MA", name: "Maroc", dial: "212" },
  { iso: "FR", name: "France", dial: "33" },
  { iso: "IT", name: "Italie", dial: "39" },
  { iso: "DE", name: "Allemagne", dial: "49" },
  { iso: "BE", name: "Belgique", dial: "32" },
  { iso: "ES", name: "Espagne", dial: "34" },
  { iso: "GB", name: "Royaume-Uni", dial: "44" },
  { iso: "US", name: "États-Unis", dial: "1" },
  { iso: "CA", name: "Canada", dial: "1" },
  { iso: "SA", name: "Arabie saoudite", dial: "966" },
  { iso: "AE", name: "Émirats arabes unis", dial: "971" },
  { iso: "QA", name: "Qatar", dial: "974" },
  { iso: "TR", name: "Turquie", dial: "90" },
];

/** Everyone else, alphabetical by French name. Israel is intentionally excluded. */
const REST: readonly CountryDial[] = [
  { iso: "AF", name: "Afghanistan", dial: "93" },
  { iso: "ZA", name: "Afrique du Sud", dial: "27" },
  { iso: "AL", name: "Albanie", dial: "355" },
  { iso: "AD", name: "Andorre", dial: "376" },
  { iso: "AO", name: "Angola", dial: "244" },
  { iso: "AG", name: "Antigua-et-Barbuda", dial: "1268" },
  { iso: "AR", name: "Argentine", dial: "54" },
  { iso: "AM", name: "Arménie", dial: "374" },
  { iso: "AU", name: "Australie", dial: "61" },
  { iso: "AT", name: "Autriche", dial: "43" },
  { iso: "AZ", name: "Azerbaïdjan", dial: "994" },
  { iso: "BS", name: "Bahamas", dial: "1242" },
  { iso: "BH", name: "Bahreïn", dial: "973" },
  { iso: "BD", name: "Bangladesh", dial: "880" },
  { iso: "BB", name: "Barbade", dial: "1246" },
  { iso: "BZ", name: "Belize", dial: "501" },
  { iso: "BJ", name: "Bénin", dial: "229" },
  { iso: "BT", name: "Bhoutan", dial: "975" },
  { iso: "BY", name: "Biélorussie", dial: "375" },
  { iso: "MM", name: "Birmanie (Myanmar)", dial: "95" },
  { iso: "BO", name: "Bolivie", dial: "591" },
  { iso: "BA", name: "Bosnie-Herzégovine", dial: "387" },
  { iso: "BW", name: "Botswana", dial: "267" },
  { iso: "BR", name: "Brésil", dial: "55" },
  { iso: "BN", name: "Brunei", dial: "673" },
  { iso: "BG", name: "Bulgarie", dial: "359" },
  { iso: "BF", name: "Burkina Faso", dial: "226" },
  { iso: "BI", name: "Burundi", dial: "257" },
  { iso: "KH", name: "Cambodge", dial: "855" },
  { iso: "CM", name: "Cameroun", dial: "237" },
  { iso: "CV", name: "Cap-Vert", dial: "238" },
  { iso: "CL", name: "Chili", dial: "56" },
  { iso: "CN", name: "Chine", dial: "86" },
  { iso: "CY", name: "Chypre", dial: "357" },
  { iso: "CO", name: "Colombie", dial: "57" },
  { iso: "KM", name: "Comores", dial: "269" },
  { iso: "CG", name: "Congo", dial: "242" },
  { iso: "CD", name: "Congo (RDC)", dial: "243" },
  { iso: "KR", name: "Corée du Sud", dial: "82" },
  { iso: "KP", name: "Corée du Nord", dial: "850" },
  { iso: "CR", name: "Costa Rica", dial: "506" },
  { iso: "CI", name: "Côte d'Ivoire", dial: "225" },
  { iso: "HR", name: "Croatie", dial: "385" },
  { iso: "CU", name: "Cuba", dial: "53" },
  { iso: "DK", name: "Danemark", dial: "45" },
  { iso: "DJ", name: "Djibouti", dial: "253" },
  { iso: "DM", name: "Dominique", dial: "1767" },
  { iso: "EG", name: "Égypte", dial: "20" },
  { iso: "EC", name: "Équateur", dial: "593" },
  { iso: "ER", name: "Érythrée", dial: "291" },
  { iso: "EE", name: "Estonie", dial: "372" },
  { iso: "SZ", name: "Eswatini", dial: "268" },
  { iso: "ET", name: "Éthiopie", dial: "251" },
  { iso: "FJ", name: "Fidji", dial: "679" },
  { iso: "FI", name: "Finlande", dial: "358" },
  { iso: "GA", name: "Gabon", dial: "241" },
  { iso: "GM", name: "Gambie", dial: "220" },
  { iso: "GE", name: "Géorgie", dial: "995" },
  { iso: "GH", name: "Ghana", dial: "233" },
  { iso: "GR", name: "Grèce", dial: "30" },
  { iso: "GD", name: "Grenade", dial: "1473" },
  { iso: "GT", name: "Guatemala", dial: "502" },
  { iso: "GN", name: "Guinée", dial: "224" },
  { iso: "GW", name: "Guinée-Bissau", dial: "245" },
  { iso: "GQ", name: "Guinée équatoriale", dial: "240" },
  { iso: "GY", name: "Guyana", dial: "592" },
  { iso: "HT", name: "Haïti", dial: "509" },
  { iso: "HN", name: "Honduras", dial: "504" },
  { iso: "HU", name: "Hongrie", dial: "36" },
  { iso: "IN", name: "Inde", dial: "91" },
  { iso: "ID", name: "Indonésie", dial: "62" },
  { iso: "IQ", name: "Irak", dial: "964" },
  { iso: "IR", name: "Iran", dial: "98" },
  { iso: "IE", name: "Irlande", dial: "353" },
  { iso: "IS", name: "Islande", dial: "354" },
  { iso: "JM", name: "Jamaïque", dial: "1876" },
  { iso: "JP", name: "Japon", dial: "81" },
  { iso: "JO", name: "Jordanie", dial: "962" },
  { iso: "KZ", name: "Kazakhstan", dial: "7" },
  { iso: "KE", name: "Kenya", dial: "254" },
  { iso: "KG", name: "Kirghizistan", dial: "996" },
  { iso: "KI", name: "Kiribati", dial: "686" },
  { iso: "KW", name: "Koweït", dial: "965" },
  { iso: "LA", name: "Laos", dial: "856" },
  { iso: "LS", name: "Lesotho", dial: "266" },
  { iso: "LV", name: "Lettonie", dial: "371" },
  { iso: "LB", name: "Liban", dial: "961" },
  { iso: "LR", name: "Libéria", dial: "231" },
  { iso: "LI", name: "Liechtenstein", dial: "423" },
  { iso: "LT", name: "Lituanie", dial: "370" },
  { iso: "LU", name: "Luxembourg", dial: "352" },
  { iso: "MK", name: "Macédoine du Nord", dial: "389" },
  { iso: "MG", name: "Madagascar", dial: "261" },
  { iso: "MY", name: "Malaisie", dial: "60" },
  { iso: "MW", name: "Malawi", dial: "265" },
  { iso: "MV", name: "Maldives", dial: "960" },
  { iso: "ML", name: "Mali", dial: "223" },
  { iso: "MT", name: "Malte", dial: "356" },
  { iso: "MH", name: "Îles Marshall", dial: "692" },
  { iso: "MU", name: "Maurice", dial: "230" },
  { iso: "MR", name: "Mauritanie", dial: "222" },
  { iso: "MX", name: "Mexique", dial: "52" },
  { iso: "FM", name: "Micronésie", dial: "691" },
  { iso: "MD", name: "Moldavie", dial: "373" },
  { iso: "MC", name: "Monaco", dial: "377" },
  { iso: "MN", name: "Mongolie", dial: "976" },
  { iso: "ME", name: "Monténégro", dial: "382" },
  { iso: "MZ", name: "Mozambique", dial: "258" },
  { iso: "NA", name: "Namibie", dial: "264" },
  { iso: "NR", name: "Nauru", dial: "674" },
  { iso: "NP", name: "Népal", dial: "977" },
  { iso: "NI", name: "Nicaragua", dial: "505" },
  { iso: "NE", name: "Niger", dial: "227" },
  { iso: "NG", name: "Nigéria", dial: "234" },
  { iso: "NO", name: "Norvège", dial: "47" },
  { iso: "NZ", name: "Nouvelle-Zélande", dial: "64" },
  { iso: "NL", name: "Pays-Bas", dial: "31" },
  { iso: "OM", name: "Oman", dial: "968" },
  { iso: "UG", name: "Ouganda", dial: "256" },
  { iso: "UZ", name: "Ouzbékistan", dial: "998" },
  { iso: "PK", name: "Pakistan", dial: "92" },
  { iso: "PW", name: "Palaos", dial: "680" },
  { iso: "PS", name: "Palestine", dial: "970" },
  { iso: "PA", name: "Panama", dial: "507" },
  { iso: "PG", name: "Papouasie-Nouvelle-Guinée", dial: "675" },
  { iso: "PY", name: "Paraguay", dial: "595" },
  { iso: "PE", name: "Pérou", dial: "51" },
  { iso: "PH", name: "Philippines", dial: "63" },
  { iso: "PL", name: "Pologne", dial: "48" },
  { iso: "PT", name: "Portugal", dial: "351" },
  { iso: "RO", name: "Roumanie", dial: "40" },
  { iso: "RU", name: "Russie", dial: "7" },
  { iso: "RW", name: "Rwanda", dial: "250" },
  { iso: "KN", name: "Saint-Kitts-et-Nevis", dial: "1869" },
  { iso: "LC", name: "Sainte-Lucie", dial: "1758" },
  { iso: "SM", name: "Saint-Marin", dial: "378" },
  { iso: "VC", name: "Saint-Vincent-et-les-Grenadines", dial: "1784" },
  { iso: "SB", name: "Îles Salomon", dial: "677" },
  { iso: "WS", name: "Samoa", dial: "685" },
  { iso: "ST", name: "Sao Tomé-et-Principe", dial: "239" },
  { iso: "SN", name: "Sénégal", dial: "221" },
  { iso: "RS", name: "Serbie", dial: "381" },
  { iso: "SC", name: "Seychelles", dial: "248" },
  { iso: "SL", name: "Sierra Leone", dial: "232" },
  { iso: "SG", name: "Singapour", dial: "65" },
  { iso: "SK", name: "Slovaquie", dial: "421" },
  { iso: "SI", name: "Slovénie", dial: "386" },
  { iso: "SO", name: "Somalie", dial: "252" },
  { iso: "SD", name: "Soudan", dial: "249" },
  { iso: "SS", name: "Soudan du Sud", dial: "211" },
  { iso: "LK", name: "Sri Lanka", dial: "94" },
  { iso: "SE", name: "Suède", dial: "46" },
  { iso: "CH", name: "Suisse", dial: "41" },
  { iso: "SR", name: "Suriname", dial: "597" },
  { iso: "SY", name: "Syrie", dial: "963" },
  { iso: "TJ", name: "Tadjikistan", dial: "992" },
  { iso: "TZ", name: "Tanzanie", dial: "255" },
  { iso: "TD", name: "Tchad", dial: "235" },
  { iso: "CZ", name: "Tchéquie", dial: "420" },
  { iso: "TH", name: "Thaïlande", dial: "66" },
  { iso: "TL", name: "Timor oriental", dial: "670" },
  { iso: "TG", name: "Togo", dial: "228" },
  { iso: "TO", name: "Tonga", dial: "676" },
  { iso: "TT", name: "Trinité-et-Tobago", dial: "1868" },
  { iso: "TM", name: "Turkménistan", dial: "993" },
  { iso: "TV", name: "Tuvalu", dial: "688" },
  { iso: "UA", name: "Ukraine", dial: "380" },
  { iso: "UY", name: "Uruguay", dial: "598" },
  { iso: "VU", name: "Vanuatu", dial: "678" },
  { iso: "VA", name: "Vatican", dial: "379" },
  { iso: "VE", name: "Venezuela", dial: "58" },
  { iso: "VN", name: "Viêt Nam", dial: "84" },
  { iso: "YE", name: "Yémen", dial: "967" },
  { iso: "ZM", name: "Zambie", dial: "260" },
  { iso: "ZW", name: "Zimbabwe", dial: "263" },
];

/** All dial codes: the priority region first (Tunisia default), then everyone else
 *  alphabetically. Israel is intentionally excluded. */
export const COUNTRY_DIAL_CODES: readonly CountryDial[] = [...PRIORITY, ...REST];

/** Split a stored phone into a dial code + the national remainder, for prefilling. */
export function splitPhone(raw: string | null | undefined): { dial: string; national: string } {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return { dial: DEFAULT_DIAL, national: "" };
  // Leading "00" is the IDD form of "+": strip it so the remainder re-enters recognition
  // (e.g. "00216…" → TN, "0033…" → FR). The >8 guard leaves a short bare local number alone.
  if (digits.startsWith("00") && digits.length > 8) digits = digits.slice(2);
  if (digits.startsWith(DEFAULT_DIAL)) {
    return { dial: DEFAULT_DIAL, national: digits.slice(DEFAULT_DIAL.length) };
  }
  // A short number (≤ 8 digits) is a bare Tunisian local number.
  if (digits.length <= 8) return { dial: DEFAULT_DIAL, national: digits };
  // Otherwise match the LONGEST dial prefix that still leaves ≥ 6 national digits.
  const byLen = COUNTRY_DIAL_CODES.filter((c) => c.dial !== DEFAULT_DIAL).sort(
    (a, b) => b.dial.length - a.dial.length,
  );
  for (const c of byLen) {
    if (digits.startsWith(c.dial) && digits.length - c.dial.length >= 6) {
      return { dial: c.dial, national: digits.slice(c.dial.length) };
    }
  }
  return { dial: DEFAULT_DIAL, national: digits };
}

/** Compose the stored value from a dial code + national digits (e.g. "+216 20123456"). */
export function composePhone(dial: string, national: string): string {
  const nat = (national ?? "").replace(/\D/g, "");
  return nat ? `+${dial} ${nat}` : "";
}
