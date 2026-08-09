import { ProductReference, Quote } from "@ebike-backend/database";

export function findQuote(
  ref: ProductReference,
  quoteId: string,
): Quote | undefined {
  return ref.quotes?.find((q) => q.id === quoteId);
}
