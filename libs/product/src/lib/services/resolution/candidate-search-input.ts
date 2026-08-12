import type {
  ProductResolutionBrand,
  ProductResolutionInput,
} from '@fittkereso-backend/database';

export interface CandidateSearchInput {
  input: ProductResolutionInput;
  brand?: ProductResolutionBrand;
}
