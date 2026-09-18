import { Injectable } from '@nestjs/common';
import { MailgunConfigService } from '@fittkereso-backend/config';
import { EmailService } from './email.service';
import { EmailTemplateService } from './email-template.service';

@Injectable()
export class PasswordResetEmailService {
  constructor(
    private readonly emailService: EmailService,
    private readonly templateService: EmailTemplateService,
    private readonly mailgunConfig: MailgunConfigService,
  ) {}

  async sendPasswordReset(params: {
    email: string;
    resetUrl: string;
  }): Promise<void> {
    const { html, text } = this.templateService.render('password-reset', {
      email: params.email,
      resetUrl: params.resetUrl,
    });

    await this.emailService.send({
      to: params.email,
      from: `fittkereso Admin <noreply@${this.mailgunConfig.domain}>`,
      subject: 'Reset your fittkereso admin password',
      html,
      text,
    });
  }
}
