import { Injectable } from '@nestjs/common';
import { RecaptchaConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class RecaptchaService {
  private readonly logger = new CustomLogger(RecaptchaService.name);

  constructor(private readonly recaptchaConfig: RecaptchaConfigService) {}

  async verifyToken(token: string): Promise<boolean> {
    const { secretKey, minScore } = this.recaptchaConfig;

    const params = new URLSearchParams({
      secret: secretKey,
      response: token,
    });

    const response = await fetch(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );

    const data = await response.json();

    if (!data.success) {
      this.logger.warn('reCAPTCHA verification failed', data);
      return false;
    }

    if (data.score !== undefined && data.score < minScore) {
      this.logger.warn(
        `reCAPTCHA score ${data.score} below threshold ${minScore}`,
      );
      return false;
    }

    return true;
  }
}
