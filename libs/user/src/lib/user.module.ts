import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { SupabaseModule } from '@fittkereso-backend/supabase';
import { AuthModule } from '@fittkereso-backend/auth';
import { EmailModule } from '@fittkereso-backend/email';
import {
  MeUpdateService,
  PasswordResetService,
  SellerMembershipService,
  SetPasswordService,
  SignInRecordService,
  UserCreateService,
  UserDeleteService,
  UserDetailService,
  UserUpdateService,
} from './services';

@Module({
  imports: [DatabaseModule, SupabaseModule, AuthModule, EmailModule],
  controllers: [],
  providers: [
    UserCreateService,
    UserDetailService,
    UserUpdateService,
    UserDeleteService,
    SetPasswordService,
    SignInRecordService,
    MeUpdateService,
    PasswordResetService,
    SellerMembershipService,
  ],
  exports: [
    UserCreateService,
    UserDetailService,
    UserUpdateService,
    UserDeleteService,
    SetPasswordService,
    SignInRecordService,
    MeUpdateService,
    PasswordResetService,
    SellerMembershipService,
  ],
})
export class UserModule {}
