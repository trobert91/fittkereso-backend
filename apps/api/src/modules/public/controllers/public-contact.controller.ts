import { Controller, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { PublicContactService } from '../services/public-contact.service';
import { PublicFeedbackService } from '../services/public-feedback.service';
import { ContactFormDto } from '../dto/contact-form.dto';
import { ReviewFeedbackDto } from '../dto/review-feedback.dto';

@Controller('v1/public')
@UseGuards(ThrottlerGuard)
export class PublicContactController {
  constructor(
    private readonly contactService: PublicContactService,
    private readonly feedbackService: PublicFeedbackService,
  ) {}

  @Post('contact')
  @Throttle({ contact: { ttl: 600_000, limit: 3 } })
  async submitContact(
    @Body() dto: ContactFormDto,
  ): Promise<{ success: boolean }> {
    await this.contactService.submitContact({
      name: dto.name,
      email: dto.email,
      message: dto.message,
      recaptchaToken: dto.recaptchaToken,
    });
    return { success: true };
  }

  @Post('reviews/:reviewId/feedback')
  @Throttle({ feedback: { ttl: 3_600_000, limit: 5 } })
  async submitFeedback(
    @Param('reviewId') reviewId: string,
    @Body() dto: ReviewFeedbackDto,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      null;

    await this.feedbackService.submitFeedback({
      reviewId,
      category: dto.category,
      description: dto.description,
      recaptchaToken: dto.recaptchaToken,
      ipAddress,
    });
    return { success: true };
  }
}
