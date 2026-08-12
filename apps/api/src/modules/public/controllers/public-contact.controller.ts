import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PublicContactService } from '../services/public-contact.service';
import { ContactFormDto } from '../dto/contact-form.dto';

@Controller('v1/public')
@UseGuards(ThrottlerGuard)
export class PublicContactController {
  constructor(private readonly contactService: PublicContactService) {}

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
}
