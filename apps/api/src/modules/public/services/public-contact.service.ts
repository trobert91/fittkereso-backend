import { Injectable, BadRequestException } from '@nestjs/common';
import { ContactEmailService } from '@fittkereso-backend/email';
import { RecaptchaService } from './recaptcha.service';

@Injectable()
export class PublicContactService {
  constructor(
    private readonly recaptchaService: RecaptchaService,
    private readonly contactEmailService: ContactEmailService,
  ) {}

  async submitContact(params: {
    name: string;
    email: string;
    message: string;
    recaptchaToken: string;
  }): Promise<void> {
    const verified = await this.recaptchaService.verifyToken(
      params.recaptchaToken,
    );
    if (!verified) {
      throw new BadRequestException('reCAPTCHA verification failed');
    }

    await this.contactEmailService.sendContactEmail({
      senderName: params.name,
      senderEmail: params.email,
      message: params.message,
    });
  }
}
