import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { ReviewFeedbackCategory } from "@ebike-backend/database";

export class ReviewFeedbackDto {
  @IsNotEmpty()
  @IsEnum(ReviewFeedbackCategory)
  category: ReviewFeedbackCategory;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNotEmpty()
  @IsString()
  recaptchaToken: string;
}
