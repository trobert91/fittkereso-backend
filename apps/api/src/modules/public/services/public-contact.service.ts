import { Injectable, BadRequestException } from '@nestjs/common';
import { ContactEmailService } from '@fittkereso-backend/email';
import { RecaptchaService } from './recaptcha.service';

/** The reCAPTCHA v3 action the site's contact form executes. */
export const CONTACT_RECAPTCHA_ACTION = 'contact';

@Injectable()
export class PublicContactService {
  constructor(
    private readonly recaptchaService: RecaptchaService,
    private readonly contactEmailService: ContactEmailService,
  ) {}

  async submitContact(params: {
    name: string;
    email: string;
    phone?: string;
    message: string;
    recaptchaToken: string;
  }): Promise<void> {
    const verified = await this.recaptchaService.verifyToken(
      params.recaptchaToken,
      CONTACT_RECAPTCHA_ACTION,
    );
    if (!verified) {
      throw new BadRequestException('reCAPTCHA verification failed');
    }

    await this.contactEmailService.sendContactEmail({
      senderName: params.name,
      senderEmail: params.email,
      senderPhone: params.phone,
      message: params.message,
    });
  }
}
