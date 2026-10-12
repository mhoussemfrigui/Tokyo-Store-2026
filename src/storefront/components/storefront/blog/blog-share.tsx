"use client";

import { useEffect, useState } from "react";
import { Link2, MessageCircle, Instagram, Bookmark } from "lucide-react";
import { cn } from "@/storefront/lib/utils";

const CIRCLE = "grid size-11 place-items-center rounded-full transition-colors";

function savedKey(url: string) {
  const segments = url.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? url;
  return "blog:saved:" + last;
}

export function BlogShare(props: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      setSaved(window.localStorage.getItem(savedKey(props.url)) === "1");
    } catch {
      // ignore unavailable storage
    }
  }, [props.url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(props.url);
    } catch {
      // ignore clipboard failures
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function toggleSaved() {
    setSaved((prev) => {
      const next = !prev;
      try {
        if (next) {
          window.localStorage.setItem(savedKey(props.url), "1");
        } else {
          window.localStorage.removeItem(savedKey(props.url));
        }
      } catch {
        // ignore unavailable storage
      }
      return next;
    });
  }

  const whatsappHref =
    "https://wa.me/?text=" + encodeURIComponent(props.title + " " + props.url);
  const facebookHref =
    "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(props.url);
  const xHref =
    "https://x.com/intent/post?text=" +
    encodeURIComponent(props.title) +
    "&url=" +
    encodeURIComponent(props.url);

  async function copyThenOpen(target: string) {
    try {
      await navigator.clipboard.writeText(props.url);
    } catch {
      // ignore clipboard failures
    }
    window.open(target, "_blank");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={copyLink}
        className="flex h-11 items-center gap-2 rounded-full border-[1.5px] border-border bg-card px-4 text-sm font-bold text-foreground hover:border-foreground"
      >
        <Link2 className="size-4" />
        {copied ? "Lien copié" : "Copier le lien"}
      </button>

      <a
        href={whatsappHref}
        target="_blank"
        rel="noopener"
        className={cn(CIRCLE, "bg-success/10 text-success")}
      >
        <MessageCircle className="size-5" />
      </a>

      <a
        href={facebookHref}
        target="_blank"
        className={cn(CIRCLE, "bg-muted text-foreground")}
      >
        <span className="font-black text-base">f</span>
      </a>

      <button
        type="button"
        onClick={() => copyThenOpen("https://www.instagram.com/")}
        aria-label="Partager sur Instagram"
        className={cn(CIRCLE, "text-white")}
        style={{ background: "linear-gradient(45deg,#f9b233,#e1306c 50%,#833ab4)" }}
      >
        <Instagram className="size-5" />
      </button>

      <a
        href={xHref}
        target="_blank"
        className={cn(CIRCLE, "bg-foreground text-background")}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
          <path d="M18.9 2H22l-7.6 8.7L23.3 22h-7l-5.4-7.1L4.6 22H1.5l8.1-9.3L1 2h7.1l4.9 6.5L18.9 2zm-1.2 18h1.9L7.4 4H5.4l12.3 16z" />
        </svg>
      </a>

      <button
        type="button"
        onClick={() => copyThenOpen("https://www.tiktok.com/")}
        className={cn(CIRCLE, "bg-foreground text-background")}
        style={{ boxShadow: "inset 0 0 0 2px #25f4ee" }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-5">
          <path d="M16.6 2h-3.4v13.3a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9a6.4 6.4 0 1 0 5.4 6.3V8.6a8 8 0 0 0 4.4 1.3V6.5a4.6 4.6 0 0 1-4.4-4.5z" />
        </svg>
      </button>

      <button
        type="button"
        onClick={toggleSaved}
        aria-pressed={saved}
        aria-label="Enregistrer"
        className={cn(
          CIRCLE,
          saved ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        <Bookmark className="size-5" fill={saved ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
