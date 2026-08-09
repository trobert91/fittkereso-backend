import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class ContactFormDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  message: string;

  @IsNotEmpty()
  @IsString()
  recaptchaToken: string;
}
