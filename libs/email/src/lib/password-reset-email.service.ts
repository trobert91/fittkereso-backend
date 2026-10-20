import { Injectable } from '@nestjs/common';
import { MailgunConfigService } from '@fittkereso-backend/config';
import { EmailService } from './email.service';
import { EmailTemplateService } from './email-template.service';

/**
 * The mark in the mail's header, served by the admin app from its public/
 * folder (the partner portal's mails use the same file, served by the site).
 */
export const EMAIL_LOGO_PATH = '/email/fittkereso-mark.png';

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
    /** The admin app's origin: the logo and the footer link resolve against it. */
    adminUrl: string;
  }): Promise<void> {
    const { html, text } = this.templateService.render('password-reset', {
      email: params.email,
      resetUrl: params.resetUrl,
      logoUrl: new URL(EMAIL_LOGO_PATH, params.adminUrl).toString(),
      adminUrl: params.adminUrl,
      adminHost: new URL(params.adminUrl).host,
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
