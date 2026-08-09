import type {
  ProductResolutionBrand,
  ProductResolutionInput,
} from "@ebike-backend/database";

export interface CandidateSearchInput {
  input: ProductResolutionInput;
  brand?: ProductResolutionBrand;
}
