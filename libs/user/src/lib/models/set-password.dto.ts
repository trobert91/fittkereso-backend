import { IsString, MinLength } from 'class-validator';

/**
 * Stricter than the temporary password minimum on purpose: a temporary
 * password is short-lived and read aloud, a chosen one is not.
 */
export const MIN_CHOSEN_PASSWORD_LENGTH = 8;

export class SetPasswordDto {
  @IsString()
  @MinLength(MIN_CHOSEN_PASSWORD_LENGTH)
  password: string;
}
