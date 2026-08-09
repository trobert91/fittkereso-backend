import { Controller, Post, Body } from "@nestjs/common";
import { KeywordResearchOrchestrator } from "@ebike-backend/thread-search";

@Controller("thread-search-test")
export class ThreadSearchTestController {
  constructor(private readonly orchestrator: KeywordResearchOrchestrator) {}

  @Post("trigger-cycle")
  async triggerCycle(
    @Body() body?: { categorySlugs?: string[]; overrideTotal?: number },
  ) {
    return this.orchestrator.execute(body);
  }
}
