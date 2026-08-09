import { Injectable } from "@nestjs/common";
import { RedditConfigService } from "@ebike-backend/config";
import Snoowrap from "snoowrap";

@Injectable()
export class RedditClientService {
  private _redditClient: Snoowrap;

  constructor(private readonly redditConfigService: RedditConfigService) {
    this._redditClient = new Snoowrap({
      userAgent: this.redditConfigService.userAgent,
      clientId: this.redditConfigService.clientId,
      clientSecret: this.redditConfigService.clientSecret,
      refreshToken: this.redditConfigService.refreshToken,
    });
    this.redditClient.config({
      continueAfterRatelimitError: true,
      maxRetryAttempts: 3,
      debug: true,
      retryErrorCodes: [502, 503, 504, 522, 429],
      // Enforce a minimum delay between every snoowrap request (including
      // internal morechildren calls from expandReplies). Without this,
      // snoowrap fires all morechildren requests back-to-back with 0ms gap,
      // triggering Reddit's per-endpoint burst throttle even when
      // ratelimitRemaining is high.
      requestDelay: 250,
    });
  }

  get redditClient(): Snoowrap {
    return this._redditClient;
  }
}
