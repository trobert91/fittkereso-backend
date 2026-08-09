import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import {
  Task,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  TaskRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { compact } from "lodash";

@Injectable()
export class PipelineHealthTools {
  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly taskRepo: TaskRepository,
    private readonly commentRepo: UserCommentRepository,
  ) {}

  @Tool({
    name: "get_pipeline_health",
    description:
      "Get pipeline health overview — thread status distribution, stuck threads (processRunning=true for too long), task queue status, recent comment processing activity. Use to diagnose processing issues.",
    parameters: z.object({}),
    annotations: { readOnlyHint: true },
  })
  async getPipelineHealth(): Promise<string> {
    // Thread status distribution
    const threadStatusColumn = `t.${nameOf<Thread>("status")}`;
    const threadStats: { status: string; count: string }[] =
      await this.threadRepo.repo
        .createQueryBuilder("t")
        .select(threadStatusColumn, "status")
        .addSelect("COUNT(*)::int", "count")
        .groupBy(threadStatusColumn)
        .orderBy("count", "DESC")
        .getRawMany();

    // Stuck threads (processRunning = true)
    const stuckThreads = await this.threadRepo.repo
      .createQueryBuilder("t")
      .leftJoinAndSelect(`t.${nameOf<Thread>("categories")}`, "threadCategory")
      .leftJoinAndSelect(
        `threadCategory.${nameOf<ThreadProductCategory>("productCategory")}`,
        "cat",
      )
      .where(`t.${nameOf<Thread>("processRunning")} = true`)
      .orderBy(`t.${nameOf<Thread>("updatedAt")}`, "ASC")
      .take(10)
      .getMany();

    // Task queue status
    const taskQueueColumn = `t.${nameOf<Task>("queue")}`;
    const taskStatusColumn = `t.${nameOf<Task>("status")}`;
    const taskStats: { queue: string; status: string; count: string }[] =
      await this.taskRepo.repo
        .createQueryBuilder("t")
        .select(taskQueueColumn, "queue")
        .addSelect(taskStatusColumn, "status")
        .addSelect("COUNT(*)::int", "count")
        .groupBy(taskQueueColumn)
        .addGroupBy(taskStatusColumn)
        .orderBy(taskQueueColumn, "ASC")
        .addOrderBy("count", "DESC")
        .getRawMany();

    // Recent comment activity (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentComments: number = await this.commentRepo.repo
      .createQueryBuilder("c")
      .where(`c.${nameOf<UserComment>("updatedAt")} > :since`, {
        since: oneHourAgo,
      })
      .getCount();

    // Comments in review
    const inReviewCount: number = await this.commentRepo.repo
      .createQueryBuilder("c")
      .where(`c.${nameOf<UserComment>("status")} = :status`, {
        status: "in_review",
      })
      .getCount();

    const L: string[] = [];
    L.push("# Pipeline Health");
    L.push("");

    // Thread status
    L.push("## Thread Status Distribution");
    L.push("| Status | Count |");
    L.push("|--------|-------|");
    for (const row of threadStats) {
      L.push(`| ${row.status} | ${row.count} |`);
    }
    L.push("");

    // Stuck threads
    if (stuckThreads.length > 0) {
      L.push(`## Stuck Threads (processRunning=true) — ${stuckThreads.length}`);
      L.push("| ID | Title | Status | Category | Updated |");
      L.push("|----|-------|--------|----------|---------|");
      for (const t of stuckThreads) {
        const title =
          t.title.length > 50 ? t.title.slice(0, 47) + "..." : t.title;
        const category =
          compact(
            (t.categories ?? [])
              .sort((a, b) => a.rank - b.rank)
              .map((tc) => tc.productCategory?.name),
          ).join(", ") || "—";
        const updated = t.updatedAt ? timeSince(t.updatedAt) : "—";
        L.push(
          `| ${t.id} | ${title} | ${t.status} | ${category} | ${updated} |`,
        );
      }
      L.push("");
    } else {
      L.push("## Stuck Threads");
      L.push("_No stuck threads (processRunning=true)._");
      L.push("");
    }

    // Task queue status
    if (taskStats.length > 0) {
      // Pivot: group by queue, show status counts
      const queues = new Map<string, Map<string, number>>();
      for (const row of taskStats) {
        if (!queues.has(row.queue)) queues.set(row.queue, new Map());
        queues.get(row.queue)!.set(row.status, Number(row.count));
      }

      L.push("## Task Queue Status");
      L.push("| Queue | Pending | Processing | Done | Failed |");
      L.push("|-------|---------|------------|------|--------|");
      for (const [queue, statuses] of queues) {
        L.push(
          `| ${queue} | ${statuses.get("pending") ?? 0} | ${statuses.get("processing") ?? 0} | ${statuses.get("done") ?? 0} | ${statuses.get("failed") ?? 0} |`,
        );
      }
      L.push("");
    }

    // Recent activity
    L.push("## Recent Activity");
    L.push(`- **Comments updated in last hour**: ${recentComments}`);
    L.push(`- **Comments in review**: ${inReviewCount}`);
    L.push("");

    return L.join("\n");
  }
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
