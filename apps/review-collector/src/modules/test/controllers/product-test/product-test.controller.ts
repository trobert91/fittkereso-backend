import { Body, Controller, Post } from "@nestjs/common";
import {
  ProductReferenceRepository,
  ProductReference,
  UserComment,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { ProductReferenceResolutionService } from "@ebike-backend/thread-processor";

@Controller("product-test")
export class ProductTestController {
  constructor(
    private readonly productResolverService: ProductReferenceResolutionService,
    private readonly referenceRepo: ProductReferenceRepository,
  ) {}

  @Post("/resolve")
  async resolve(
    @Body()
    body: {
      referenceId: string;
    },
  ) {
    const reference = await this.referenceRepo.findOneOrFail({
      where: { id: body.referenceId },
      relations: [
        nameOf<ProductReference>("comment"),
        `${nameOf<ProductReference>("comment")}.${nameOf<UserComment>("thread")}`,
      ],
    });

    // Reset resolution state for testing
    reference.resolutionFinished = false;

    return this.productResolverService.resolve(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      reference.comment!.thread,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      reference.comment!,
      reference,
    );
  }
}
