import { Injectable } from "@nestjs/common";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { SupabaseConfigService } from "@ebike-backend/config";

@Injectable()
export class SupabaseClientService {
  private readonly client: SupabaseClient;

  constructor(private readonly config: SupabaseConfigService) {
    const url = this.config.url;
    const key = this.config.apiKey;

    this.client = createClient(url, key);
  }

  getClient(): SupabaseClient {
    return this.client;
  }
}
