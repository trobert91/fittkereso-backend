import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SupabaseConfigService } from '@fittkereso-backend/config';

/**
 * Supabase client built with the service-role (secret) key.
 *
 * Grants unrestricted `auth.admin.*` access, so it must never receive a
 * user-supplied token or be reachable from a browser. Prefer
 * SupabaseAuthAdminService over using this client directly - that service is
 * the single place GoTrue errors get translated into HTTP responses.
 */
@Injectable()
export class SupabaseAdminClientService {
  private readonly client: SupabaseClient;

  constructor(private readonly config: SupabaseConfigService) {
    this.client = createClient(this.config.url, this.config.secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }
}
