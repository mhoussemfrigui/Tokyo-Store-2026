import "server-only";

import { z } from "zod";

import { showcaseService } from "@/modules/showcase";
import { bus } from "@/events/bus";
import { COLLECTION_SLUGS, type CollectionSlug } from "@/lib/pages/collection-slugs";
import { fail, ok, workflow } from "../shared";

/** Replace the manual product pins for a showcase collection page. */
const schema = z.object({
  // Derived from the single slug source (collection-slugs.ts) so a new vitrine
  // added there is accepted here too, instead of failing « Validation échouée ».
  slug: z.enum(COLLECTION_SLUGS as unknown as [CollectionSlug, ...CollectionSlug[]]),
  // Validate UUID shape up front so a malformed id fails as a clean validation
  // error before the DB round-trip (the pins land in a uuid product_id column).
  productIds: z.array(z.string().uuid()).max(50),
});

export const setShowcasePinsWorkflow = workflow<
  [z.input<typeof schema>, { actorUserId: string }],
  { slug: string; count: number }
>("showcase.set_pins", async (input, { actorUserId }) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const ids = Array.from(
    new Set(parsed.data.productIds.map((s) => s.trim()).filter(Boolean)),
  );
  await showcaseService.setPins(parsed.data.slug, ids);
  await bus.emit(
    "showcase.pins_set",
    { collection: parsed.data.slug, count: ids.length },
    { actorUserId },
  );
  return ok({ slug: parsed.data.slug, count: ids.length });
});
