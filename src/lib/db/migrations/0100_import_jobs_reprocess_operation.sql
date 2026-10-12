-- 0100 — allow the 'reprocess' operation on import_jobs.
--
-- The product white-background reprocess feature ("Détourage des produits
-- existants", src/workflows/media/reprocess-product-white-bg.ts) inserts jobs
-- with operation='reprocess', but the original `import_jobs_operation_chk`
-- (migration 0002) only permitted 'import' | 'clean'. So EVERY reprocess insert
-- failed with a 23514 check-constraint violation before the job could start —
-- the operator saw a generic "échec" with no usable detail.
--
-- The `DataOperation` TS type + the OPERATION_LABEL map already include
-- 'reprocess'; this brings the DB constraint back in lockstep. Drop-then-add
-- (IF EXISTS) keeps re-apply idempotent. `source_chk` already allows 'upload'
-- and there is no segment CHECK, so this is the only constraint that blocked it.
ALTER TABLE "import_jobs" DROP CONSTRAINT IF EXISTS "import_jobs_operation_chk";
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_operation_chk" CHECK ("operation" IN ('import', 'clean', 'reprocess'));
