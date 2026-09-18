import { Module } from '@nestjs/common';
import {
  SupabaseAdminClientService,
  SupabaseAuthAdminService,
  SupabaseClientService,
  SupabaseJwtService,
} from './services';

@Module({
  controllers: [],
  providers: [
    SupabaseClientService,
    SupabaseAdminClientService,
    SupabaseAuthAdminService,
    SupabaseJwtService,
  ],
  exports: [
    SupabaseClientService,
    SupabaseAdminClientService,
    SupabaseAuthAdminService,
    SupabaseJwtService,
  ],
})
export class SupabaseModule {}
