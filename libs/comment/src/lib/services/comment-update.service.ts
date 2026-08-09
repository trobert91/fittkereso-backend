import { Injectable } from "@nestjs/common";
import {
  ProductReference,
  ProductReferenceCandidate,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { UpdateCommentDto } from "../models/update-comment.dto";
import { CommentUpdateMapperService } from "./comment-update-mapper.service";

@Injectable()
export class CommentUpdateService {
  constructor(
    private readonly commentRepo: UserCommentRepository,
    private readonly mapper: CommentUpdateMapperService,
  ) {}

  public async updateComment(
    id: string,
    dto: UpdateCommentDto,
  ): Promise<UserComment> {
    const comment = await this.getCommentById(id);
    await this.mapper.mapDtoToEntity(dto, comment);

    return this.commentRepo.save(comment);
  }

  private async getCommentById(id: string): Promise<UserComment> {
    return this.commentRepo.findOneOrFail({
      where: { id },
      relations: [
        nameOf<UserComment>("productReferences"),
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}`,
      ],
    });
  }
}
