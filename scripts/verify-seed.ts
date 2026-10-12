import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";

async function main() {
  const one = async (q: ReturnType<typeof sql>) =>
    (await db.execute(q)).rows[0].n as number;
  const products = await one(sql`SELECT count(*)::int n FROM products`);
  const withBrand = await one(
    sql`SELECT count(DISTINCT product_id)::int n FROM product_brands`,
  );
  const withCat = await one(
    sql`SELECT count(DISTINCT product_id)::int n FROM product_categories`,
  );
  const withImg = await one(
    sql`SELECT count(DISTINCT product_id)::int n FROM product_media`,
  );
  console.log(
    JSON.stringify({ products, withBrand, withCategory: withCat, withImage: withImg }),
  );

  const byBrand = await db.execute(
    sql`SELECT b.name, count(*)::int n FROM product_brands pb JOIN brands b ON b.id = pb.brand_id GROUP BY b.name ORDER BY n DESC`,
  );
  console.log("BRANDS:", JSON.stringify(byBrand.rows));

  const byCat = await db.execute(
    sql`SELECT c.slug, count(*)::int n FROM product_categories pc JOIN categories c ON c.id = pc.category_id GROUP BY c.slug ORDER BY n DESC`,
  );
  console.log("CATEGORIES:", JSON.stringify(byCat.rows));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e?.message ?? e);
  process.exit(1);
});
