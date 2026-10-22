"use client";

import { useActionState, useMemo, useState } from "react";
import { Plus, Trash2, Video } from "lucide-react";

import { saveReelsAction } from "@/lib/actions/reels";
import { type ActionState } from "@/lib/actions/types";
import {
  REEL_PLATFORMS,
  REEL_PLATFORM_LABELS,
  REEL_TOPICS,
  type ReelPlatform,
  type ReelTopic,
  type ReelVideo,
} from "@/lib/cms/reels-content";

type Row = {
  id: string;
  title: string;
  platform: ReelPlatform;
  topic: ReelTopic;
  videoUrl: string;
  posterUrl: string;
  productSlugsText: string;
};

const FIELD =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-slate-900";
const LABEL = "flex flex-col gap-1.5 text-xs font-semibold text-slate-600";

let counter = 0;
const newId = () => `reel-${Date.now()}-${counter++}`;

export function ReelsAdminPanel({ videos }: { videos: ReelVideo[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    videos.map((v) => ({
      id: v.id,
      title: v.title,
      platform: v.platform,
      topic: v.topic,
      videoUrl: v.videoUrl,
      posterUrl: v.posterUrl,
      productSlugsText: v.productSlugs.join(", "),
    })),
  );
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveReelsAction,
    null,
  );

  const json = useMemo(
    () =>
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          platform: r.platform,
          topic: r.topic,
          videoUrl: r.videoUrl,
          posterUrl: r.posterUrl,
          productSlugs: r.productSlugsText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })),
      ),
    [rows],
  );

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));
  const add = () =>
    setRows((rs) => [
      ...rs,
      {
        id: newId(),
        title: "",
        platform: "tiktok",
        topic: "Nouveautés",
        videoUrl: "",
        posterUrl: "",
        productSlugsText: "",
      },
    ]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
          <Video aria-hidden className="size-5" /> Vidéos (Reels)
        </h1>
        <p className="max-w-2xl text-sm text-slate-500">
          Les vidéos affichées sur la page <code>/reels</code>. Chaque vidéo est un vrai post
          (TikTok / Instagram / Facebook) avec les produits présentés. Aucune statistique
          (vues / likes) n&apos;est inventée. Laissez la liste vide pour masquer la galerie.
        </p>
      </header>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="reels_json" value={json} />

        {rows.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            Aucune vidéo. Ajoutez-en une ci-dessous — ou laissez vide pour masquer la page.
          </p>
        )}

        <ul className="flex flex-col gap-4">
          {rows.map((r, i) => (
            <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
                  Vidéo {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  <Trash2 aria-hidden className="size-3.5" /> Supprimer
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={`${LABEL} sm:col-span-2`}>
                  Titre
                  <input
                    className={FIELD}
                    value={r.title}
                    onChange={(e) => update(r.id, { title: e.target.value })}
                    placeholder="Unboxing du casque Redmi Neo"
                  />
                </label>
                <label className={LABEL}>
                  Plateforme
                  <select
                    className={FIELD}
                    value={r.platform}
                    onChange={(e) => update(r.id, { platform: e.target.value as ReelPlatform })}
                  >
                    {REEL_PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {REEL_PLATFORM_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={LABEL}>
                  Sujet
                  <select
                    className={FIELD}
                    value={r.topic}
                    onChange={(e) => update(r.id, { topic: e.target.value as ReelTopic })}
                  >
                    {REEL_TOPICS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={`${LABEL} sm:col-span-2`}>
                  Lien du post (URL de la vidéo)
                  <input
                    className={FIELD}
                    value={r.videoUrl}
                    onChange={(e) => update(r.id, { videoUrl: e.target.value })}
                    placeholder="https://www.tiktok.com/@tokyostore/video/…"
                  />
                </label>
                <label className={`${LABEL} sm:col-span-2`}>
                  Image d&apos;aperçu (URL — optionnel)
                  <input
                    className={FIELD}
                    value={r.posterUrl}
                    onChange={(e) => update(r.id, { posterUrl: e.target.value })}
                    placeholder="/cdn/products/… ou https://…"
                  />
                </label>
                <label className={`${LABEL} sm:col-span-2`}>
                  Produits présentés (slugs catalogue, séparés par des virgules)
                  <input
                    className={FIELD}
                    value={r.productSlugsText}
                    onChange={(e) => update(r.id, { productSlugsText: e.target.value })}
                    placeholder="casque-bluetooth-redmi-headphones-neo-blanc, …"
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={add}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Plus aria-hidden className="size-4" /> Ajouter une vidéo
          </button>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Enregistrement…" : "Enregistrer"}
          </button>
          {state && (
            <span
              className={`text-sm font-medium ${state.ok ? "text-green-600" : "text-red-600"}`}
            >
              {state.message}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
