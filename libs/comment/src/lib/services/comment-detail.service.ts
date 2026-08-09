import { Injectable } from "@nestjs/common";
import {
  getPrimaryModel,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  Thread,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { ProductImageDtoService } from "@ebike-backend/product";
import { compact } from "lodash";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class CommentDetailService {
  constructor(
    private readonly commentRepo: UserCommentRepository,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  public async getCommentById(commentId: string): Promise<UserComment> {
    const comment = await this.commentRepo.findOneOrFail({
      where: { id: commentId },
      relations: [
        nameOf<UserComment>("thread"),
        `${nameOf<UserComment>("thread")}.${nameOf<Thread>("categories")}`,
        `${nameOf<UserComment>("thread")}.categories.productCategory`,
        nameOf<UserComment>("parent"),
        `${nameOf<UserComment>("parent")}.${nameOf<UserComment>("parent")}`,
        nameOf<UserComment>("productReferences"),
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("productCategory")}`,
        `${nameOf<UserComment>("productReferences")}.${nameOf<ProductReference>("candidates")}.${nameOf<ProductReferenceCandidate>("model")}.${nameOf<ProductModel>("mainImage")}`,
      ],
    });

    this.imageDtoService.updateProductImageUrls(
      compact((comment.productReferences ?? []).map((r) => getPrimaryModel(r))),
    );

    return comment;
  }
}
