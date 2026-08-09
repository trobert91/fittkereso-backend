import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { MailgunConfigService } from "@ebike-backend/config";
import { EmailService } from "./email.service";
import { EmailTemplateService } from "./email-template.service";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class ContactEmailService {
  private readonly logger = new CustomLogger(ContactEmailService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly templateService: EmailTemplateService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly mailgunConfig: MailgunConfigService,
  ) {}

  async sendContactEmail(params: {
    senderName: string;
    senderEmail: string;
    message: string;
  }): Promise<void> {
    const adminEmail = this.dynamicConfigService.general.adminContactEmail;

    if (!adminEmail) {
      this.logger.error("adminContactEmail not configured in DynamicConfig");
      throw new Error("Admin contact email not configured");
    }

    const { html, text } = this.templateService.render("contact", {
      senderName: params.senderName,
      senderEmail: params.senderEmail,
      message: params.message,
    });

    await this.emailService.send({
      to: adminEmail,
      from: `ebike Contact <noreply@${this.mailgunConfig.domain}>`,
      subject: `Contact Form: ${params.senderName}`,
      html,
      text,
    });
  }
}
