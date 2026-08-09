import { Module } from "@nestjs/common";
import { ThreadAdminController } from "./controllers/thread-admin.controller";
import { ThreadAdminService } from "./services/thread-admin.service";
import { DatabaseModule } from "@ebike-backend/database";
import { ThreadProcessorModule } from "../thread-processor/thread-processor.module";

@Module({
  imports: [DatabaseModule, ThreadProcessorModule],
  controllers: [ThreadAdminController],
  providers: [ThreadAdminService],
})
export class AdminModule {}
