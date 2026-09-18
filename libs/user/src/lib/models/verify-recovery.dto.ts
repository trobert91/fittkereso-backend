import { IsNotEmpty, IsString } from 'class-validator';

/** The hashed recovery token lifted from a password-reset link. */
export class VerifyRecoveryDto {
  @IsString()
  @IsNotEmpty()
  tokenHash: string;
}
