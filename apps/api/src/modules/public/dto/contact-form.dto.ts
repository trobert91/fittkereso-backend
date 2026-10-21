import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// The site's contact form (fittkereso-frontend src/components/contact/contact-form.tsx), which
// repeats these limits as its inputs' maxLength.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ContactFormDto {
  @Transform(trim)
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  name: string;

  @Transform(trim)
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(320)
  email: string;

  /** Optional: the form asks for it, but an answer by email needs none. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^\+?[0-9 ()./-]+$/, { message: 'phone must be a phone number' })
  phone?: string;

  @Transform(trim)
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  message: string;

  @IsNotEmpty()
  @IsString()
  recaptchaToken: string;
}
