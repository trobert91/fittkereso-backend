import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshTokenDto {
  /** Optional: falls back to the refresh_token cookie when absent. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
