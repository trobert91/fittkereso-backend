import { Quote } from "@ebike-backend/database";

export function nextQuoteId(existing: Quote[]): string {
  const used = new Set(existing.map((q) => q.id).filter(Boolean));
  for (let n = 1; ; n++) {
    const id = `q${n}`;
    if (!used.has(id)) return id;
  }
}

export function ensureQuoteIds(quotes: Quote[] | undefined): Quote[] {
  if (!quotes) return [];
  for (const quote of quotes) {
    if (!quote.id) quote.id = nextQuoteId(quotes);
  }
  return quotes;
}
