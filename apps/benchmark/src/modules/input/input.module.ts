import { Module } from "@nestjs/common";
import { SubtreeBuilderService } from "@ebike-backend/thread-processor";
import { ThreadModule } from "@ebike-backend/thread";
import { DatabaseModule } from "@ebike-backend/database";
import { InputProviderService } from "./input-provider.service";
import { RealThreadInputService } from "./real-thread-input.service";
import { FixtureInputService } from "./fixture-input.service";

@Module({
  imports: [DatabaseModule, ThreadModule],
  providers: [
    SubtreeBuilderService,
    InputProviderService,
    RealThreadInputService,
    FixtureInputService,
  ],
  exports: [InputProviderService],
})
export class InputModule {}
