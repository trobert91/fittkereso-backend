/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SupabaseConfigService {
  constructor(private configService: ConfigService) {}

  get url(): string {
    return this.configService.get<string>('supabase.url')!;
  }

  get apiKey(): string {
    return this.configService.get<string>('supabase.api_key')!;
  }

  /**
   * Service-role (secret) key. Grants auth.admin.* access - never expose it
   * outside the backend, and never use it for user-facing sign-in calls.
   */
  get secretKey(): string {
    return this.configService.get<string>('supabase.secret_key')!;
  }
}
