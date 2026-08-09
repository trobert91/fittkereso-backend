import { Depth } from "@ebike-backend/database";
import { ProductRegistryEntry } from "../models/product-registry.model";

/**
 * Recency ordering used by cheat-sheet slot selection (lower = higher priority).
 * Distinct from RECENCY_PRIORITY in product-registry which scores recency upward.
 */
export const RECENCY_RANK: Record<ProductRegistryEntry["recency"], number> = {
  in_op: 0,
  latest: 0,
  recent: 1,
  earlier: 2,
};

/** Depth ordering shared by registry build (entry consolidation) and rendering. */
export const DEPTH_RANK: Record<Depth, number> = {
  [Depth.Comprehensive]: 3,
  [Depth.Detailed]: 2,
  [Depth.Mentioned]: 1,
  [Depth.Superficial]: 0,
};

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
