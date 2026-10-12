/**
 * Drizzle client for one-off scripts (seed-catalog, bench-catalog).
 *
 * Mirrors `@/lib/db/client` but WITHOUT the `server-only` guard so it can
 * be imported from tsx-launched scripts. Use only from `pnpm db:*` scripts —
 * never from app code (always use the server-only client there). The
 * migrator (migrate.ts) builds its own pool instead, since it also runs as
 * bundled CJS where `@/*` aliases don't resolve.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo";

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

export const scriptDb = drizzle({ client: pool, schema, casing: "snake_case" });
export const scriptPool = pool;
