import { Module } from '@nestjs/common';
import { ResolutionTestController } from './resolution-test/resolution-test.controller';
import { SearchAgentTestController } from './search-agent-test/search-agent-test.controller';
import { ResolutionModule } from '@fittkereso-backend/resolution';
import { DatabaseModule } from '@fittkereso-backend/database';
import { AuthModule } from '@fittkereso-backend/auth';

@Module({
  imports: [DatabaseModule, ResolutionModule, AuthModule],
  controllers: [ResolutionTestController, SearchAgentTestController],
})
export class TestModule {}
