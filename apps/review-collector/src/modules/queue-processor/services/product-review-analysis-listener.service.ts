import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { ProductReviewAnalysisService } from "@ebike-backend/product";
import { ProductReviewAnalysisMessage } from "@ebike-backend/task";

@Injectable()
export class ProductReviewAnalysisListener {
  private readonly logger = new CustomLogger(
    ProductReviewAnalysisListener.name,
  );

  constructor(private readonly analysisService: ProductReviewAnalysisService) {}

  async process(message: ProductReviewAnalysisMessage): Promise<void> {
    if (!message?.productId) {
      this.logger.warn("ProductReviewAnalysis task missing productId payload");
      return;
    }
    await this.analysisService.analyzeProduct(message.productId);
  }
}
