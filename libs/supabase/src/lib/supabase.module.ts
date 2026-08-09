import { Module } from '@nestjs/common';
import { SupabaseClientService } from './services/supabase-client.service';
import { SupabaseJwtService } from './services';

@Module({
  controllers: [],
  providers: [SupabaseClientService, SupabaseJwtService],
  exports: [SupabaseClientService, SupabaseJwtService],
})
export class SupabaseModule {}
