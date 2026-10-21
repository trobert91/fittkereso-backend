import {
  Controller,
  Post,
  Body,
  UseGuards,
  SerializeOptions,
} from '@nestjs/common';
import { Public } from '@fittkereso-backend/utils';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PublicContactService } from '../services/public-contact.service';
import { ContactFormDto } from '../dto/contact-form.dto';

// The public website's contact form (fittkereso-frontend /kapcsolat) posts here from the browser,
// so the site's origin has to be in the CORS list (app.ts). It stays when the rest of the public
// module is retired: the site has no reCAPTCHA secret and no contact address of its own.
@Controller('v1/public')
@Public()
@UseGuards(ThrottlerGuard)
export class PublicContactController {
  constructor(private readonly contactService: PublicContactService) {}

  @Post('contact')
  @Throttle({ contact: { ttl: 600_000, limit: 3 } })
  // A plain object: without exposeAll the global excludeAll serializer answers {}.
  @SerializeOptions({ strategy: 'exposeAll' })
  async submitContact(
    @Body() dto: ContactFormDto,
  ): Promise<{ success: boolean }> {
    await this.contactService.submitContact({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      message: dto.message,
      recaptchaToken: dto.recaptchaToken,
    });
    return { success: true };
  }
}
