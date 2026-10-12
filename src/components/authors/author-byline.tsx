import Image from "next/image";
import Link from "next/link";

import { authorPath } from "@/lib/authors/author-path";
import type { PublicAuthorRef } from "@/modules/authors";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Article byline. Prefers the editorial author profile (avatar + link to the
 * /auteur archive + jobTitle); falls back to a plain name (the staff
 * author_user_id display name) when no profile is set, and renders nothing when
 * neither is available.
 */
export function AuthorByline({
  author,
  fallbackName,
  prefix = "Par",
  size = 28,
  className,
}: {
  author: PublicAuthorRef | null;
  fallbackName?: string | null;
  prefix?: string;
  size?: number;
  className?: string;
}) {
  const name = author?.name ?? fallbackName ?? null;
  if (!name) return null;

  const avatar = author?.avatarUrl ? (
    <Image
      src={author.avatarUrl}
      alt={name}
      width={size}
      height={size}
      className="rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-foreground/90 font-semibold text-background"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initialsOf(name)}
    </span>
  );

  const label = (
    <>
      {prefix ? `${prefix} ` : ""}
      <span className="font-medium text-foreground">{name}</span>
      {author?.jobTitle ? <span className="text-muted-foreground"> · {author.jobTitle}</span> : null}
    </>
  );

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      {avatar}
      {author ? (
        <Link href={authorPath(author.slug)} className="transition hover:text-foreground">
          {label}
        </Link>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}
