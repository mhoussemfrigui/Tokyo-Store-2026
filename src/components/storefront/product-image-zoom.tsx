"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Search } from "lucide-react";

import type { ProductImage } from "@/types/catalog";

/**
 * PDP desktop main-image frame — a clean WHITE packshot background with a
 * hover MAGNIFY lens you can LOCK on (the "Zoom" toggle, bottom-right).
 *
 * The selected gallery image still crossfades (opacity). With zoom locked on,
 * moving the pointer over the frame pans a full-frame, 230%-magnified view of
 * the current image (cursor-following `background-position`). A faithful port
 * of the Tokyo Lovable reference's ImageZoom. Desktop-only — mobile keeps the
 * swipe slider (no hover surface).
 */
export function ProductImageZoom({
  images,
  alts,
  selected,
  productName,
  discount,
}: {
  images: ProductImage[];
  alts: (string | null | undefined)[];
  selected: number;
  productName: string;
  discount: number;
}) {
  const [zoomOn, setZoomOn] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const frameRef = useRef<HTMLDivElement>(null);

  const current = images[selected] ?? images[0];
  // Coerce to a string URL for the CSS magnify background (runtime values are
  // always /cdn media URLs; the StaticImageData branch is for type-safety only).
  const currentSrc = current == null ? "" : typeof current === "string" ? current : current.src;
  const lensActive = zoomOn && hovering && Boolean(currentSrc);

  function onMove(e: React.MouseEvent) {
    const el = frameRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    setPos({ x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) });
  }

  return (
    <div
      ref={frameRef}
      className="group relative aspect-[3/4] flex-1 overflow-hidden rounded-2xl border border-border/50 bg-muted"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onMouseMove={zoomOn ? onMove : undefined}
      style={{ cursor: zoomOn ? (lensActive ? "zoom-out" : "zoom-in") : "default" }}
    >
      {images.map((g, i) => (
        <div
          key={i}
          className={`absolute inset-0 p-6 transition-opacity duration-500 ease-out md:p-10 ${
            i === selected ? "opacity-100" : "opacity-0"
          }`}
        >
          <Image
            src={g}
            alt={alts[i] ?? productName}
            fill
            sizes="(max-width: 1024px) 100vw, 600px"
            priority={i === 0}
            className="object-contain drop-shadow-[0_16px_28px_rgba(0,0,0,0.12)]"
          />
        </div>
      ))}

      {/* Magnify lens — full-frame, cursor-following 230% view of the current
          image, shown only while zoom is locked on and the pointer is inside. */}
      {lensActive && (
        <div
          aria-hidden
          className="absolute inset-0 z-10 bg-muted"
          style={{
            backgroundImage: `url("${currentSrc}")`,
            backgroundRepeat: "no-repeat",
            backgroundSize: "230%",
            backgroundPosition: `${pos.x}% ${pos.y}%`,
          }}
        />
      )}

      {discount > 0 && (
        <span className="absolute left-4 top-4 z-20 rounded-full bg-foreground/90 px-3 py-1.5 text-[0.6rem] font-medium uppercase tracking-[0.15em] text-background backdrop-blur">
          −{discount}%
        </span>
      )}

      <button
        type="button"
        onClick={() => setZoomOn((v) => !v)}
        aria-pressed={zoomOn}
        className={`absolute bottom-4 right-4 z-20 inline-flex items-center gap-1.5 rounded-full px-3 py-2 font-body text-[0.6rem] uppercase tracking-[0.12em] backdrop-blur-md transition-all duration-300 ${
          zoomOn
            ? "bg-primary text-primary-foreground shadow-lg"
            : "bg-foreground/10 text-foreground/70 hover:bg-foreground/20"
        }`}
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.6} />
        {zoomOn ? "Zoom actif" : "Zoom"}
      </button>
    </div>
  );
}
