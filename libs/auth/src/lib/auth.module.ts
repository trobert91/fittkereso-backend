import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { LoginService } from "./services/login.service";
import { SupabaseModule } from "@ebike-backend/supabase";
import { UserAuthService } from "./services";
import { AuthGuard, RoleGuard } from "./guards";

@Module({
  imports: [DatabaseModule, SupabaseModule],
  controllers: [],
  providers: [AuthGuard, RoleGuard, LoginService, UserAuthService],
  exports: [AuthGuard, RoleGuard, LoginService, UserAuthService],
})
export class AuthModule {}
