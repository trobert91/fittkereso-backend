import { Module } from '@nestjs/common';
import { AuthModule } from '@fittkereso-backend/auth';
import { AuthController } from './controllers/auth.controller';

@Module({
  imports: [AuthModule],
  controllers: [AuthController],
})
export class ApiAuthModule {}
