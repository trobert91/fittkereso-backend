import { Quote } from "@ebike-backend/database";
import { uniq } from "lodash";
import { ReviewQuoteDto } from "../dto/review.dto";

/**
 * Project a Quote (from `Review.quotes` JSONB) into the public-facing
 * ReviewQuoteDto, exposing the evidence labels so the frontend can highlight
 * the quote(s) that match the active feature / use case / issue filter.
 */
export function toReviewQuoteDto(quote: Quote): ReviewQuoteDto {
  const dto = new ReviewQuoteDto();
  dto.text = quote.text;
  dto.sentiment = quote.sentiment;

  const features = uniq((quote.features ?? []).map((e) => e.label));
  if (features.length > 0) dto.features = features;

  const useCases = uniq((quote.useCases ?? []).map((e) => e.label));
  if (useCases.length > 0) dto.useCases = useCases;

  const issues = uniq((quote.issues ?? []).map((e) => e.label));
  if (issues.length > 0) dto.issues = issues;

  if (quote.quality) dto.quality = quote.quality;

  return dto;
}
