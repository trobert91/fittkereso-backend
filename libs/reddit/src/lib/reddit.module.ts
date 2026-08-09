import { Module } from "@nestjs/common";
import {
  RedditApiQueueService,
  RedditClientService,
  RedditThreadSearchService,
  RedditThreadService,
} from "./services";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";

@Module({
  imports: [DynamicConfigModule],
  providers: [
    RedditApiQueueService,
    RedditClientService,
    RedditThreadSearchService,
    RedditThreadService,
  ],
  exports: [
    RedditApiQueueService,
    RedditClientService,
    RedditThreadSearchService,
    RedditThreadService,
  ],
})
export class RedditModule {}
