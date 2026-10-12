import { slugify } from "@/lib/slug";
import { parsePriceToMinor, type ImportedProduct, type ParsedImport } from "./types";

/**
 * CSV product parser — RFC 4180 (quoted fields, `""` escapes, fields may
 * contain the delimiter and newlines). The delimiter is auto-detected from
 * the header line (`,` vs `;` — Excel-fr exports semicolons), and headers
 * are matched case-insensitively after trimming.
 *
 * Columns: `name` (required), `slug`, `price_dinars` (required),
 * `old_price_dinars`, `availability`, `brand`, `gtin`, `mpn` (alias `sku`),
 * `category_path` (" / "-separated), `image_url`, `additional_image_urls`
 * ("|"-separated), `short_desc`, `description`, `meta_title`,
 * `meta_description`.
 *
 * A missing required HEADER throws (whole-file failure). A row missing its
 * name or a parseable price lands in `rowErrors` and is skipped — same
 * contract as parseGoogleFeed.
 */
export function parseCsvProducts(csv: string): ParsedImport {
  // Strip a leading UTF-8 BOM — Excel / Notepad CSV exports carry one, which
  // would otherwise make the first header "﻿name" and falsely report the
  // required `name` column missing on a perfectly valid file.
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const delimiter = detectDelimiter(firstLogicalLine(text));
  const records = parseRecords(text, delimiter);
  if (records.length === 0) {
    throw new Error("Fichier CSV vide.");
  }

  const headers = records[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => headers.indexOf(name);

  const nameIdx = col("name");
  const priceIdx = col("price_dinars");
  if (nameIdx === -1 || priceIdx === -1) {
    const missing = [nameIdx === -1 ? "name" : null, priceIdx === -1 ? "price_dinars" : null]
      .filter(Boolean)
      .join(", ");
    throw new Error(`En-tête CSV invalide : colonne(s) requise(s) manquante(s) — ${missing}.`);
  }

  const slugIdx = col("slug");
  const oldPriceIdx = col("old_price_dinars");
  const availabilityIdx = col("availability");
  const brandIdx = col("brand");
  const gtinIdx = col("gtin");
  // `sku` is accepted as an alias of `mpn` (the runner stores mpn into both).
  const mpnIdx = col("mpn") !== -1 ? col("mpn") : col("sku");
  const categoryPathIdx = col("category_path");
  const imageUrlIdx = col("image_url");
  const additionalImagesIdx = col("additional_image_urls");
  const shortDescIdx = col("short_desc");
  const descriptionIdx = col("description");
  const metaTitleIdx = col("meta_title");
  const metaDescriptionIdx = col("meta_description");

  const products: ImportedProduct[] = [];
  const rowErrors: string[] = [];

  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    if (record.every((field) => field.trim() === "")) continue; // blank line

    const rowNo = r + 1; // human-facing, header = line 1
    const cell = (idx: number): string | null => {
      if (idx === -1 || idx >= record.length) return null;
      const v = record[idx].trim();
      return v.length > 0 ? v : null;
    };

    const name = cell(nameIdx);
    if (!name) {
      rowErrors.push(`Ligne ${rowNo}: nom manquant`);
      continue;
    }

    const priceRaw = cell(priceIdx);
    const priceMinor = priceRaw ? parsePriceToMinor(priceRaw) : null;
    if (priceMinor === null) {
      rowErrors.push(`Ligne ${rowNo}: prix manquant ou invalide (« ${priceRaw ?? ""} »)`);
      continue;
    }

    const slugRaw = cell(slugIdx);
    const slug = slugRaw ? slugify(slugRaw) : slugify(name);
    if (!slug) {
      rowErrors.push(`Ligne ${rowNo}: impossible de dériver un slug`);
      continue;
    }

    const oldPriceRaw = cell(oldPriceIdx);
    const imageUrls = [
      cell(imageUrlIdx),
      ...(cell(additionalImagesIdx)?.split("|") ?? []).map((u) => u.trim()),
    ].filter((u): u is string => Boolean(u));

    products.push({
      sourceId: null,
      title: name,
      slug,
      link: null,
      description: cell(descriptionIdx),
      shortDesc: cell(shortDescIdx),
      imageUrls: [...new Set(imageUrls)],
      priceMinor,
      oldPriceMinor: oldPriceRaw ? parsePriceToMinor(oldPriceRaw) : null,
      availability: parseAvailability(cell(availabilityIdx)),
      brandName: cell(brandIdx),
      gtin: cell(gtinIdx),
      mpn: cell(mpnIdx),
      categoryPath: (cell(categoryPathIdx)?.split(" / ") ?? []).map((s) => s.trim()).filter(Boolean),
      metaTitle: cell(metaTitleIdx),
      metaDescription: cell(metaDescriptionIdx),
    });
  }

  return { products, rowErrors };
}

/* ────────────────────────────────────────────────────────── low-level CSV */

function parseAvailability(raw: string | null): ImportedProduct["availability"] {
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/\s+/g, "_");
  if (v === "in_stock" || v === "out_of_stock" || v === "backorder") return v;
  return null;
}

/** The header line, accounting for quoted fields (a quoted header could in theory contain a newline). */
function firstLogicalLine(csv: string): string {
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "\n" && !inQuotes) return csv.slice(0, i);
  }
  return csv;
}

/** Count `,` vs `;` outside quotes in the header — the winner is the delimiter. */
function detectDelimiter(headerLine: string): "," | ";" {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (const ch of headerLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ",") commas += 1;
      else if (ch === ";") semicolons += 1;
    }
  }
  return semicolons > commas ? ";" : ",";
}

/**
 * RFC 4180 state machine. Inside quotes everything is literal (`""` = one
 * quote); outside quotes the delimiter splits fields and `\n` splits records
 * (`\r` is swallowed so CRLF files parse identically).
 */
function parseRecords(csv: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}
