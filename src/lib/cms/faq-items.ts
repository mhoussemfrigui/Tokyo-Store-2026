/**
 * Pure parser for the product/category/brand FAQ editor payload (a JSON array
 * serialized into a hidden form input). Shared by the dedicated FAQ save action
 * AND the main product save (which now persists FAQs in the same submit, so the
 * operator never has to remember a second "Enregistrer la FAQ" click). No
 * server/DB deps — unit-testable.
 */
export type FaqItemInput = {
  question: string;
  answer: string;
  displayOrder: number;
  isPublished: boolean;
};

export function parseFaqItemsJson(raw: string | undefined | null): FaqItemInput[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: FaqItemInput[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question.trim() : "";
    const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
    if (!question || !answer) continue;
    const rawOrder =
      typeof obj.displayOrder === "number" ? obj.displayOrder : Number(obj.displayOrder);
    items.push({
      question,
      answer,
      displayOrder: Number.isFinite(rawOrder) ? Math.max(0, Math.trunc(rawOrder)) : 0,
      // Absent/!==false ⇒ published (the editor checkbox defaults on).
      isPublished: obj.isPublished !== false,
    });
  }
  return items;
}
