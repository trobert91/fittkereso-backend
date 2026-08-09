import { Injectable } from "@nestjs/common";
import {
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  Review,
  Thread,
  ThreadRepository,
  UserComment,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { ThreadContextService } from "../../thread-processor/services/thread-context.service";

@Injectable()
export class ThreadAdminService {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly userCommentMapService: ThreadContextService,
  ) {}

  public async getThreadById(id: string) {
    const thread = await this.threadRepository.repo
      .createQueryBuilder("thread")
      .leftJoinAndSelect(`thread.${nameOf<Thread>("comments")}`, "comment")
      .leftJoinAndSelect(
        `comment.${nameOf<UserComment>("productReferences")}`,
        "productReference",
      )
      .leftJoinAndSelect(
        `productReference.${nameOf<ProductReference>("candidates")}`,
        "candidate",
      )
      .leftJoinAndSelect(
        `candidate.${nameOf<ProductReferenceCandidate>("model")}`,
        "resolvedModel",
      )
      .leftJoinAndSelect(
        `resolvedModel.${nameOf<ProductModel>("brand")}`,
        "brand",
      )
      .leftJoinAndSelect(`review.${nameOf<Review>("model")}`, "productModel")
      .leftJoinAndSelect(
        `productModel.${nameOf<ProductModel>("aliases")}`,
        "productAlias",
      )
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id })
      .getOne();

    if (!thread) {
      throw new Error("Thread not found");
    }

    return {
      ...thread,
      comments: this.userCommentMapService.createThreadContext(thread.comments),
    };
  }
}
