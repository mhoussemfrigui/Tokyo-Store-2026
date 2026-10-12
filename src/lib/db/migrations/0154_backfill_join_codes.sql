-- 0154 — backfill join codes for allocations created before 0152.
--
-- 0152 added business_level_allocations.join_code as nullable with no backfill, so
-- an allocation created before it (upsertAllocation only mints a code on INSERT / on
-- re-save) has join_code = NULL and the « code » join method is silently unavailable
-- for that company. Mint one now: 8 chars from the unambiguous alphabet (no 0/O/1/I/L),
-- matching the app's generateJoinCode. The inner LOOP re-rolls on the vanishingly rare
-- collision so the partial unique index (business_level_alloc_join_code_uq) always holds.
-- Idempotent: only rows still NULL are touched.
DO $$
DECLARE
  r RECORD;
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code TEXT;
  i INT;
BEGIN
  FOR r IN SELECT id FROM business_level_allocations WHERE join_code IS NULL LOOP
    LOOP
      code := '';
      FOR i IN 1..8 LOOP
        code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM business_level_allocations WHERE join_code = code);
    END LOOP;
    UPDATE business_level_allocations SET join_code = code WHERE id = r.id;
  END LOOP;
END $$;
