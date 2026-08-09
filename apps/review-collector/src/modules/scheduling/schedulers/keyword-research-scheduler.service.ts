import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { KeywordResearchOrchestrator } from "@ebike-backend/thread-search";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class KeywordResearchScheduler {
  private readonly logger = new CustomLogger(KeywordResearchScheduler.name);
  private isRunning = false;

  constructor(private readonly orchestrator: KeywordResearchOrchestrator) {}

  // Every Monday at 06:00.
  @Cron("0 6 * * 1")
  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Previous run still in progress, skipping");
      return;
    }
    this.isRunning = true;
    const startTime = Date.now();
    this.logger.log("Keyword research tick starting", {});
    try {
      await this.orchestrator.execute();
      this.logger.log("Keyword research tick complete", {
        durationMs: Date.now() - startTime,
      });
    } catch (error: unknown) {
      this.logger.error("Keyword research tick failed", { error });
    } finally {
      this.isRunning = false;
    }
  }
}
