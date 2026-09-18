import { Module } from '@nestjs/common';
import { AuthModule } from '@fittkereso-backend/auth';
import { UserModule } from '@fittkereso-backend/user';
import { AuthController } from './controllers/auth.controller';

@Module({
  imports: [AuthModule, UserModule],
  controllers: [AuthController],
})
export class ApiAuthModule {}
