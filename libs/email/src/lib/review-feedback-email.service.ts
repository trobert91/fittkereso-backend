import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { MailgunConfigService } from "@ebike-backend/config";
import { EmailService } from "./email.service";
import { EmailTemplateService } from "./email-template.service";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class ReviewFeedbackEmailService {
  private readonly logger = new CustomLogger(ReviewFeedbackEmailService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly templateService: EmailTemplateService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly mailgunConfig: MailgunConfigService,
  ) {}

  async sendFeedbackNotification(params: {
    productSlug: string;
    reviewId: string;
    category: string;
    description?: string;
  }): Promise<void> {
    const adminEmail = this.dynamicConfigService.general.adminContactEmail;

    if (!adminEmail) {
      this.logger.error("adminContactEmail not configured in DynamicConfig");
      throw new Error("Admin contact email not configured");
    }

    const { html, text } = this.templateService.render("review-feedback", {
      productSlug: params.productSlug,
      reviewId: params.reviewId,
      category: params.category,
      description: params.description ?? "No description provided",
    });

    await this.emailService.send({
      to: adminEmail,
      from: `ebike Feedback <noreply@${this.mailgunConfig.domain}>`,
      subject: `Review Feedback: ${params.category}`,
      html,
      text,
    });
  }
}
