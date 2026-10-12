/**
 * White-background removal heuristic — edge flood-fill that punches the
 * connected near-white background to transparent while preserving the subject
 * and interior whites. Pure (sharp only, no DB). Synthetic images generated
 * in-memory.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/white-bg.test.ts
 */
import sharp from "sharp";

import { isPixelLimitError, MAX_INPUT_PIXELS } from "@/modules/media/image-safety";
import { removeUniformBackground } from "@/modules/media/white-bg";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/** Build a WxH PNG from a per-pixel RGB function. */
async function makePng(
  w: number,
  h: number,
  rgb: (x: number, y: number) => [number, number, number],
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const [r, g, b] = rgb(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Read the alpha of a pixel from a CHANGED result (raw RGBA, channels = 4). */
function alphaRaw(res: { data: Buffer; width: number }, x: number, y: number): number {
  return res.data[(y * res.width + x) * 4 + 3];
}

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [220, 30, 30];

async function main() {
  console.log("removeUniformBackground — white sweep around a red square:");
  {
    const img = await makePng(100, 100, (x, y) =>
      x >= 30 && x < 70 && y >= 30 && y < 70 ? RED : WHITE,
    );
    const res = await removeUniformBackground(img);
    check("changed = true", res.changed === true);
    if (res.changed) {
      check("corner (2,2) transparent", alphaRaw(res, 2, 2) === 0);
      check("subject (50,50) opaque", alphaRaw(res, 50, 50) === 255);
    }
  }

  console.log("removeUniformBackground — interior white is preserved:");
  {
    // Red frame 20..80, white interior 30..70, white outside the frame.
    const img = await makePng(100, 100, (x, y) => {
      const inFrame = x >= 20 && x < 80 && y >= 20 && y < 80;
      const inInner = x >= 30 && x < 70 && y >= 30 && y < 70;
      if (inInner) return WHITE; // enclosed white (a "dial")
      if (inFrame) return RED; // the case/subject
      return WHITE; // outer background
    });
    const res = await removeUniformBackground(img);
    check("changed = true", res.changed === true);
    if (res.changed) {
      check("outer corner transparent", alphaRaw(res, 2, 2) === 0);
      check("enclosed white (50,50) stays opaque", alphaRaw(res, 50, 50) === 255);
    }
  }

  console.log("removeUniformBackground — BLACK sweep around a light square (the fix):");
  {
    const LIGHT: [number, number, number] = [225, 225, 235];
    const BLACK: [number, number, number] = [4, 4, 4];
    const img = await makePng(100, 100, (x, y) =>
      x >= 30 && x < 70 && y >= 30 && y < 70 ? LIGHT : BLACK,
    );
    const res = await removeUniformBackground(img);
    check("changed = true (black backdrop now removed)", res.changed === true);
    if (res.changed) {
      check("corner (2,2) transparent", alphaRaw(res, 2, 2) === 0);
      check("subject (50,50) opaque", alphaRaw(res, 50, 50) === 255);
    }
  }

  console.log("removeUniformBackground — interior BLACK enclosed by subject on black sweep:");
  {
    const LIGHT: [number, number, number] = [240, 240, 240];
    const BLACK: [number, number, number] = [4, 4, 4];
    const img = await makePng(100, 100, (x, y) => {
      const inRing = x >= 20 && x < 80 && y >= 20 && y < 80;
      const inHole = x >= 40 && x < 60 && y >= 40 && y < 60;
      if (inHole) return BLACK; // enclosed black "sub-dial" matching the backdrop
      if (inRing) return LIGHT; // the case/subject
      return BLACK; // outer black backdrop
    });
    const res = await removeUniformBackground(img);
    check("changed = true", res.changed === true);
    if (res.changed) {
      check("outer black backdrop transparent", alphaRaw(res, 2, 2) === 0);
      check("enclosed black hole (50,50) stays opaque", alphaRaw(res, 50, 50) === 255);
    }
  }

  console.log("removeUniformBackground — anti-aliased edge gets a GRADED alpha:");
  {
    // White sweep, red subject 30..70, with a 1px ring of light-grey (230) at the
    // square's outer edge — a backdrop↔subject blend, as anti-aliasing produces.
    // That ring pixel is adjacent to the white backdrop and its colour distance to
    // white sits inside the feather ramp, so it must get a PARTIAL alpha (not the
    // old flat 128, and not a hard 0/255) — smooth edge, no backdrop-tinted halo.
    const GREY: [number, number, number] = [230, 230, 230];
    const img = await makePng(100, 100, (x, y) => {
      const inSquare = x >= 30 && x < 70 && y >= 30 && y < 70;
      if (!inSquare) return WHITE;
      const onEdge = x === 30 || x === 69 || y === 30 || y === 69;
      return onEdge ? GREY : RED;
    });
    const res = await removeUniformBackground(img);
    check("changed = true", res.changed === true);
    if (res.changed) {
      const edgeAlpha = alphaRaw(res, 30, 50); // grey ring pixel, adjacent to white bg
      // Must be the GRADED value, not the old flat 128 feather (which also
      // satisfied 0<128<255). dist(230,230,230 → white 255)=43.3, ramp [32,64] →
      // alpha ≈ round(((43.3-32)/32)*255) ≈ 90. Pin it (± rounding) AND reject 128.
      check(
        `grey edge pixel gets the GRADED alpha ≈90 (not the old flat 128): ${edgeAlpha}`,
        edgeAlpha !== 128 && edgeAlpha > 0 && edgeAlpha < 255 && Math.abs(edgeAlpha - 90) <= 4,
      );
      check("deep subject (50,50) stays fully opaque", alphaRaw(res, 50, 50) === 255);
      check("backdrop corner (2,2) fully transparent", alphaRaw(res, 2, 2) === 0);
    }
  }

  console.log("removeUniformBackground — no removable backdrop → untouched:");
  {
    // All-red: the border IS uniform, but the fill would eat the WHOLE frame (no
    // subject) → the maxBackgroundFraction guard returns it unchanged.
    const img = await makePng(100, 100, () => RED);
    const res = await removeUniformBackground(img);
    check("changed = false (solid colour, no subject)", res.changed === false);
    check("returns the same buffer reference", res.data === img);
  }

  console.log("removeUniformBackground — decode is capped (decompression bomb):");
  {
    // A flat 9000×7000 PNG (63 MP) compresses to ~200 KB — far under the byte
    // cap — but would decode to ~250 MB of RGBA. Must be refused, not flooded.
    const bomb = await sharp({
      create: { width: 9000, height: 7000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    check("bomb is over the pixel cap", 9000 * 7000 > MAX_INPUT_PIXELS);
    let threw: unknown = null;
    try {
      await removeUniformBackground(bomb);
    } catch (err) {
      threw = err;
    }
    check("throws sharp's pixel-limit error (caller keeps the original)", isPixelLimitError(threw));
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
