import sharp from "sharp";

import { SHARP_DECODE_LIMITS } from "./image-safety";

/**
 * Heuristic UNIFORM-backdrop removal for studio product packshots.
 *
 * What it does
 * ────────────
 * Given an image buffer, it makes the CONNECTED uniform studio backdrop
 * transparent — whatever its colour: a WHITE sweep, a BLACK sweep, or any flat
 * grey/coloured backdrop — while preserving the subject AND any interior regions
 * that share the backdrop colour (e.g. a watch's white dial on a white sweep, or
 * a black sub-dial on a black sweep). It works by:
 *   1. sampling the image BORDER and taking its MEDIAN colour as the backdrop;
 *   2. checking the border is actually UNIFORM (most border pixels match that
 *      median) — a textured / lifestyle / gradient background fails this and is
 *      left untouched;
 *   3. flood-filling backdrop-coloured pixels inward from the border. Only the
 *      backdrop reachable from the edge is removed; an enclosed interior region
 *      (e.g. a dial fully ringed by the non-backdrop case) is never reached by
 *      the fill and stays fully opaque.
 *
 * The cut edge is anti-aliased with a colour-distance GRADED alpha (an edge pixel
 * that is still a backdrop-ish blend fades out; a clearly-subject pixel stays
 * opaque), which removes the faint backdrop-tinted halo a flat feather leaves.
 *
 * Output: on a successful removal it returns the RAW RGBA buffer (+ width/height,
 * channels = 4), NOT an encoded PNG. The callers (upload processor + reprocess)
 * feed it straight into the webp/avif/jpeg encoders, so the détourage path no
 * longer pays a slow lossless PNG-9 encode here + a re-decode there (a large
 * per-image CPU saving). An UNCHANGED image returns its original encoded bytes.
 *
 * Honest limitations
 * ──────────────────
 * This is a HEURISTIC tuned for clean studio packshots on a flat sweep — it is
 * NOT AI subject segmentation. It removes a *connected, uniform* backdrop by
 * flood-fill from the edges. Consequences:
 *   - A subject on a textured, multi-coloured, or gradient background is left
 *     untouched: when the border isn't uniform, or the filled backdrop covers
 *     less than `minBackgroundFraction`, the original bytes are returned verbatim
 *     with `changed: false`.
 *   - Genuine subject pixels matching the backdrop colour that are edge-connected
 *     to it (e.g. a white strap running off-frame on a white sweep) will be
 *     removed.
 *
 * Dependency-free besides `sharp` (already a project dependency). It only
 * decodes/encodes raw pixel buffers — pure + side-effect-free, so it is shared
 * by the upload processor (server) and the offline re-process workflow (tsx).
 * Every decode is capped at MAX_INPUT_PIXELS (./image-safety): the raw RGBA
 * buffer below is 4 bytes/pixel, so an unbounded decode is a memory bomb.
 *
 * @throws if sharp cannot decode the input, or (defensively) if the decoded
 *   buffer is not 4-channel RGBA after `ensureAlpha()`. Callers should
 *   try/catch and fall back to the original image.
 */

export type WhiteBgResult =
  // changed: the RAW RGBA pixels (channels = 4) + dimensions — callers encode the
  // variants directly from these (no intermediate PNG round-trip).
  | { data: Buffer; width: number; height: number; changed: true }
  // unchanged: the ORIGINAL encoded bytes + their detected mime, untouched.
  | { data: Buffer; mime: string; changed: false };

export type RemoveBackgroundOptions = {
  /**
   * Max Euclidean RGB distance for a pixel to count as "the backdrop colour".
   * Tolerates JPEG noise / a faint vignette around a flat sweep. Default 32.
   */
  colorTolerance?: number;
  /**
   * The border is treated as a real backdrop only when at least this fraction of
   * its pixels match the median border colour (rejects textured / lifestyle /
   * gradient shots). Default 0.7 (70%).
   */
  minBorderUniformity?: number;
  /**
   * If the flood-filled backdrop covers a smaller fraction of the image than
   * this, the image is assumed NOT to be a sweep packshot and is returned
   * unchanged. Default 0.04 (4%).
   */
  minBackgroundFraction?: number;
  /**
   * If the flood-filled backdrop covers a LARGER fraction than this, there is no
   * real subject left (a solid-colour frame, or a near-empty image), so it is
   * returned unchanged rather than erased to nothing. Default 0.96 (96%).
   */
  maxBackgroundFraction?: number;
};

/** Map sharp's detected format to a MIME type for the unchanged passthrough. */
function mimeFromFormat(format: string | undefined): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

export async function removeUniformBackground(
  input: Buffer,
  opts: RemoveBackgroundOptions = {},
): Promise<WhiteBgResult> {
  const colorTolerance = opts.colorTolerance ?? 32;
  const minBorderUniformity = opts.minBorderUniformity ?? 0.7;
  const minBackgroundFraction = opts.minBackgroundFraction ?? 0.04;
  const maxBackgroundFraction = opts.maxBackgroundFraction ?? 0.96;
  const tol2 = colorTolerance * colorTolerance;

  // 1. Decode to raw RGBA. ensureAlpha() guarantees a 4th channel even for
  //    opaque sources (JPEG), so the alpha-write below is always valid.
  const { data, info } = await sharp(input, SHARP_DECODE_LIMITS)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    // Defensive: ensureAlpha() should always yield 4 channels.
    throw new Error(
      `removeUniformBackground: expected 4 channels after ensureAlpha, got ${info.channels}`,
    );
  }

  const width = info.width;
  const height = info.height;
  const total = width * height;
  if (total === 0) {
    const meta = await sharp(input, SHARP_DECODE_LIMITS).metadata();
    return { data: input, mime: mimeFromFormat(meta.format), changed: false };
  }

  // 2. BACKDROP COLOUR = the median of the border pixels (robust to a stray
  //    subject pixel touching the edge). Sampling the border — not assuming white
  //    — is what lets the same code détoure a BLACK studio sweep as well as a
  //    white one. `idx` is the pixel index (not the byte offset).
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const pushBorder = (idx: number) => {
    const o = idx * 4;
    rs.push(data[o]);
    gs.push(data[o + 1]);
    bs.push(data[o + 2]);
  };
  for (let x = 0; x < width; x++) {
    pushBorder(x);
    pushBorder((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushBorder(y * width);
    pushBorder(y * width + (width - 1));
  }
  // Sort a COPY: rs/gs/bs are captured index-aligned (one entry per border pixel)
  // and the uniformity gate below reads them back BY INDEX, so sorting in place
  // would scramble the three channels apart and make the gate compare mismatched
  // pixels — falsely passing a textured border and punching a hole in a
  // non-packshot photo.
  const median = (a: number[]): number => {
    const s = [...a].sort((p, q) => p - q);
    return s[s.length >> 1];
  };
  const br = median(rs);
  const bgc = median(gs);
  const bb = median(bs);

  // A pixel is backdrop when its colour is within `colorTolerance` (Euclidean
  // RGB) of the sampled backdrop colour.
  const isBackground = (idx: number): boolean => {
    const o = idx * 4;
    const dr = data[o] - br;
    const dg = data[o + 1] - bgc;
    const db = data[o + 2] - bb;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  // 3. UNIFORMITY GATE — a real sweep has a border that is overwhelmingly the
  //    backdrop colour. A textured / lifestyle / gradient shot fails this and is
  //    returned untouched (so we never punch a hole in a non-packshot photo).
  let borderMatch = 0;
  for (let i = 0; i < rs.length; i++) {
    const dr = rs[i] - br;
    const dg = gs[i] - bgc;
    const db = bs[i] - bb;
    if (dr * dr + dg * dg + db * db <= tol2) borderMatch++;
  }
  if (rs.length === 0 || borderMatch / rs.length < minBorderUniformity) {
    const meta = await sharp(input, SHARP_DECODE_LIMITS).metadata();
    return { data: input, mime: mimeFromFormat(meta.format), changed: false };
  }

  // 3. Flood-fill the background from the border. Explicit stack (no recursion —
  //    images can be millions of pixels). `bg[idx] === 1` marks a background
  //    pixel; we reuse it as the visited set so each pixel is pushed once.
  const bg = new Uint8Array(total);
  // Stack of pixel indices. Worst case every pixel is queued once.
  const stack = new Int32Array(total);
  let sp = 0;

  const seed = (idx: number) => {
    if (bg[idx] === 0 && isBackground(idx)) {
      bg[idx] = 1;
      stack[sp++] = idx;
    }
  };

  // Seed every border pixel that matches the backdrop colour.
  for (let x = 0; x < width; x++) {
    seed(x); // top row
    seed((height - 1) * width + x); // bottom row
  }
  for (let y = 0; y < height; y++) {
    seed(y * width); // left column
    seed(y * width + (width - 1)); // right column
  }

  let bgCount = sp; // seeds are confirmed background pixels

  // 4-connected BFS/DFS.
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx - x) / width;

    // left
    if (x > 0) {
      const n = idx - 1;
      if (bg[n] === 0 && isBackground(n)) {
        bg[n] = 1;
        bgCount++;
        stack[sp++] = n;
      }
    }
    // right
    if (x < width - 1) {
      const n = idx + 1;
      if (bg[n] === 0 && isBackground(n)) {
        bg[n] = 1;
        bgCount++;
        stack[sp++] = n;
      }
    }
    // up
    if (y > 0) {
      const n = idx - width;
      if (bg[n] === 0 && isBackground(n)) {
        bg[n] = 1;
        bgCount++;
        stack[sp++] = n;
      }
    }
    // down
    if (y < height - 1) {
      const n = idx + width;
      if (bg[n] === 0 && isBackground(n)) {
        bg[n] = 1;
        bgCount++;
        stack[sp++] = n;
      }
    }
  }

  // 4. Bail out if there is not a real connected backdrop to remove. Return the
  //    ORIGINAL input bytes (same reference) untouched, with the detected mime.
  const backgroundFraction = total > 0 ? bgCount / total : 0;
  if (backgroundFraction < minBackgroundFraction || backgroundFraction > maxBackgroundFraction) {
    // < min: no real connected sweep (e.g. a lifestyle shot). > max: the fill ate
    // the whole frame (a solid-colour image / no subject) — don't erase it.
    const meta = await sharp(input, SHARP_DECODE_LIMITS).metadata();
    return { data: input, mime: mimeFromFormat(meta.format), changed: false };
  }

  // 5. Composite the alpha in one O(n) pass, reading edges from the STABLE `bg`
  //    mask (not the alpha we're mutating):
  //      - flood-filled backdrop            → alpha 0 (removed);
  //      - a subject pixel on the cut edge  → GRADED alpha from its colour
  //        distance to the backdrop, over the ramp [tol, tol+band]: an
  //        anti-aliased blend still close to the backdrop fades toward
  //        transparent, a clearly-subject pixel stays opaque. This anti-aliases
  //        the boundary AND dissolves the faint backdrop-tinted 1px halo the hard
  //        threshold leaves, instead of stamping a flat 50% band on every edge;
  //      - interior pixels (not edge-adjacent) → untouched (regions sharing the
  //        backdrop colour, e.g. a white dial on a white sweep, stay fully opaque).
  //    Alpha is only ever REDUCED, never raised.
  const featherBand = colorTolerance; // ramp width in RGB-distance units
  for (let idx = 0; idx < total; idx++) {
    if (bg[idx] === 1) {
      data[idx * 4 + 3] = 0;
      continue;
    }
    const x = idx % width;
    const y = (idx - x) / width;
    const adjacentToBg =
      (x > 0 && bg[idx - 1] === 1) ||
      (x < width - 1 && bg[idx + 1] === 1) ||
      (y > 0 && bg[idx - width] === 1) ||
      (y < height - 1 && bg[idx + width] === 1);
    if (!adjacentToBg) continue;
    const o = idx * 4;
    const dr = data[o] - br;
    const dg = data[o + 1] - bgc;
    const db = data[o + 2] - bb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    const t = (dist - colorTolerance) / featherBand;
    const a = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
    if (a < data[o + 3]) data[o + 3] = a;
  }

  // 6. Return the RAW RGBA pixels (the buffer we own + mutated in place) — the
  //    caller encodes the variants from these, so we skip a lossless PNG encode
  //    here + a decode there.
  return { data, width, height, changed: true };
}
