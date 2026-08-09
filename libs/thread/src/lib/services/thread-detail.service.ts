import { Injectable } from "@nestjs/common";
import { Thread, ThreadRepository } from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class ThreadDetailService {
  constructor(private readonly threadRepo: ThreadRepository) {}

  public async getThreadById(threadId: string): Promise<Thread> {
    return this.threadRepo.findOneOrFail({
      where: { id: threadId },
      relations: [
        nameOf<Thread>("categories"),
        "categories.productCategory",
        nameOf<Thread>("runs"),
      ],
      order: { runs: { startedAt: "DESC" } },
    });
  }
}
