import { Module } from "@nestjs/common";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MailgunConfigService } from "@ebike-backend/config";
import { EmailService } from "./email.service";
import { EmailTemplateService } from "./email-template.service";
import { ContactEmailService } from "./contact-email.service";
import { ReviewFeedbackEmailService } from "./review-feedback-email.service";

@Module({
  imports: [DynamicConfigModule],
  providers: [
    MailgunConfigService,
    EmailService,
    EmailTemplateService,
    ContactEmailService,
    ReviewFeedbackEmailService,
  ],
  exports: [ContactEmailService, ReviewFeedbackEmailService],
})
export class EmailModule {}
