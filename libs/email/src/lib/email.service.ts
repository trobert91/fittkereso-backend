import { Injectable } from "@nestjs/common";
import { MailgunConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";

export interface SendEmailOptions {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new CustomLogger(EmailService.name);

  constructor(private readonly mailgunConfig: MailgunConfigService) {}

  async send(options: SendEmailOptions): Promise<void> {
    const { to, from, subject, html, text } = options;
    const { apiKey, domain, apiUrl } = this.mailgunConfig;

    const url = `${apiUrl}/${domain}/messages`;

    const formData = new FormData();
    formData.append("from", from);
    formData.append("to", to);
    formData.append("subject", subject);
    formData.append("html", html);
    formData.append("text", text);

    const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: authHeader },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Mailgun send failed: ${response.status} ${response.statusText}`,
        body,
      );
      throw new Error(`Mailgun send failed: ${response.status}`);
    }

    this.logger.log(`Email sent to ${to}: "${subject}"`);
  }
}
