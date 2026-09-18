import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SupabaseConfigService } from '@fittkereso-backend/config';

/**
 * Supabase client built with the publishable (anon) key.
 *
 * Handles user-facing auth calls: sign-in, token refresh, OTP verification.
 * Session persistence is disabled deliberately - this provider is a
 * process-wide singleton, so a persisted session would leak from whichever
 * request signed in last into every later call made through the same client.
 */
@Injectable()
export class SupabaseClientService {
  private readonly client: SupabaseClient;

  constructor(private readonly config: SupabaseConfigService) {
    this.client = createClient(this.config.url, this.config.apiKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }
}
