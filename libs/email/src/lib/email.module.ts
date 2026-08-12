import { Module } from '@nestjs/common';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { MailgunConfigService } from '@fittkereso-backend/config';
import { EmailService } from './email.service';
import { EmailTemplateService } from './email-template.service';
import { ContactEmailService } from './contact-email.service';

@Module({
  imports: [DynamicConfigModule],
  providers: [
    MailgunConfigService,
    EmailService,
    EmailTemplateService,
    ContactEmailService,
  ],
  exports: [ContactEmailService],
})
export class EmailModule {}
