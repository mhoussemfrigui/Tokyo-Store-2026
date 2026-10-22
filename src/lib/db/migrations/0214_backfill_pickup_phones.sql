-- 0214 — Backfill the real in-store boutique phone numbers (+ opening hours)
-- confirmed by the owner into pickup_locations, so the storefront « Nos boutiques »
-- section reads them from the backend (delivery pickup points) instead of hardcoding
-- them in promo-grid.tsx. Idempotent: re-running sets the same values.
UPDATE pickup_locations SET phone = '+216 29 111 684', hours_label = 'Lun–Sam · 09h – 20h' WHERE name = 'Lac 2 Mall Tunis';
UPDATE pickup_locations SET phone = '+216 29 599 967', hours_label = 'Lun–Sam · 09h – 20h' WHERE name = 'La Marsa';
UPDATE pickup_locations SET phone = '+216 20 254 111', hours_label = 'Lun–Sam · 09h – 20h' WHERE name = 'Menzah 5';
