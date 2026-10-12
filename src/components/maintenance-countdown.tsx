"use client";

import { useEffect, useState } from "react";

/**
 * Live countdown to a launch / reopening datetime — the crimson box set shown on
 * the coming-soon and maintenance scenes. Renders a stable placeholder on the
 * server + first paint (state starts null) so there is no hydration mismatch from
 * a server/client clock difference, then ticks every second once mounted. When the
 * target passes it renders nothing (the admin flips the mode to `live` to actually
 * reopen — this is display only).
 */
function split(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function Cell({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 max-w-[150px] flex-1 flex-col items-center gap-1.5 rounded-[24px] bg-[#f6f2ed] px-1.5 py-[clamp(14px,2vw,22px)]">
      <span className="text-[clamp(34px,5.4vw,64px)] font-black leading-none tracking-[-.04em] tabular-nums text-[#0e1218]">
        {value}
      </span>
      <span className="text-[12px] font-extrabold uppercase tracking-[.12em] text-[#5b5d62]">
        {label}
      </span>
    </span>
  );
}

export function MaintenanceCountdown({ targetIso, label }: { targetIso: string; label?: string }) {
  const target = Date.parse(targetIso);
  // null until mounted → server + first client render match (placeholder), no mismatch.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!Number.isFinite(target)) return null;

  // Post-launch: nothing to count down to.
  if (now !== null && target - now <= 0) return null;

  const t = now === null ? { days: 0, hours: 0, minutes: 0, seconds: 0 } : split(target - now);
  const placeholder = now === null;

  return (
    <div
      className="tk-fade-in-up flex w-full max-w-[620px] flex-col items-center gap-2.5"
      style={{ animationDelay: "0.24s" }}
      role="timer"
      aria-label="Compte à rebours"
      suppressHydrationWarning
    >
      {/* Optional label (e.g. maintenance "Retour en ligne dans") — kept INSIDE so
          it disappears with the boxes once the target passes (no orphan heading). */}
      {label && (
        <span className="text-[12px] font-extrabold uppercase tracking-[.14em] text-[#5b5d62]">{label}</span>
      )}
      <div className="flex w-full justify-center gap-[clamp(6px,1.2vw,12px)]">
        <Cell value={placeholder ? "—" : String(t.days)} label={t.days > 1 ? "Jours" : "Jour"} />
        <Cell value={placeholder ? "—" : pad(t.hours)} label="Heures" />
        <Cell value={placeholder ? "—" : pad(t.minutes)} label="Minutes" />
        <Cell value={placeholder ? "—" : pad(t.seconds)} label="Secondes" />
      </div>
    </div>
  );
}
