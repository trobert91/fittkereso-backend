import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@ebike-backend/database";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  DebugTraceAssemblerService,
  AssemblerTraceFilters,
} from "@ebike-backend/debug";

@Controller("admin-debug")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminDebugController {
  constructor(private readonly assembler: DebugTraceAssemblerService) {}

  @Get("thread/:threadId/trace")
  async getThreadTrace(
    @Param("threadId") threadId: string,
    @Query("detail") detail?: "summary" | "full",
    @Query("format") format?: "json" | "llm",
    @Query("commentIds") commentIdsParam?: string,
    @Query("status") statusParam?: string,
    @Query("step") stepParam?: string,
    @Query("hasErrors") hasErrors?: string,
    @Query("flagged") flagged?: string,
  ): Promise<any> {
    const filters: AssemblerTraceFilters = {
      status: statusParam ? statusParam.split(",") : undefined,
      step: stepParam ? stepParam.split(",") : undefined,
      hasErrors: hasErrors === "true",
      flagged: flagged === "true",
    };

    const detailLevel = detail || "summary";
    const outputFormat = format || "json";

    // Summary is always needed (fast — lightweight query)
    const summary = await this.assembler.assembleThreadSummary(
      threadId,
      filters,
    );

    if (detailLevel === "summary") {
      return outputFormat === "llm"
        ? { markdown: this.assembler.formatSummaryForLlm(summary) }
        : summary;
    }

    // Full detail mode
    if (outputFormat === "llm" && !commentIdsParam) {
      throw new BadRequestException(
        "commentIds parameter is required when detail=full and format=llm (to keep output within LLM context limits)",
      );
    }

    // For JSON mode without explicit commentIds, fall back to all comments from the summary
    const commentIds = commentIdsParam
      ? commentIdsParam.split(",")
      : summary.comments.map((c) => c.commentId);
    const commentTraces =
      await this.assembler.assembleCommentTraces(commentIds);

    return outputFormat === "llm"
      ? { markdown: this.assembler.formatDetailForLlm(summary, commentTraces) }
      : { summary, comments: commentTraces };
  }

  @Get("comment/:commentId/trace")
  async getCommentTrace(
    @Param("commentId") commentId: string,
    @Query("format") format?: "json" | "llm",
  ): Promise<any> {
    const commentTraces = await this.assembler.assembleCommentTraces([
      commentId,
    ]);

    if (commentTraces.length === 0) {
      throw new NotFoundException(
        `Comment ${commentId} not found or has no traces`,
      );
    }

    if (format === "llm") {
      const summary = this.assembler.buildMinimalSummary(commentTraces[0]);
      return {
        markdown: this.assembler.formatDetailForLlm(summary, commentTraces),
      };
    }

    return commentTraces[0];
  }
}
