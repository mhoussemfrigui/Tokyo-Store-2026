-- Defense-in-depth: enforce the coupon cart spend band at the DB, not only in the
-- manage workflow. A promotion with max_cart_cents < min_cart_cents is
-- unsatisfiable (no subtotal can be >= min AND <= max), so the coupon is
-- permanently inert. 0081 only checked max_cart_cents > 0; this closes the
-- cross-field gap so a raw-SQL / future-code write can't persist a dead band.
-- min_cart_cents is NOT NULL DEFAULT 0, so the predicate is well-defined.
ALTER TABLE promotions
  ADD CONSTRAINT promotions_cart_band_chk
    CHECK (max_cart_cents IS NULL OR max_cart_cents >= min_cart_cents);
