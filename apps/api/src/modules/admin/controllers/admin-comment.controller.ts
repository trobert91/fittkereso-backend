import {
  Body,
  Controller,
  Param,
  Post,
  Put,
  Req,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  CommentDetailService,
  CommentStatusService,
  CommentUpdateService,
  UpdateCommentDto,
  UpdateCommentStatusDto,
} from "@ebike-backend/comment";
import { CommentReprocessService } from "@ebike-backend/thread";
import { ProductModel, UserRole } from "@ebike-backend/database";
import { ProductImageDtoService } from "@ebike-backend/product";
import {
  CommentSearchParams,
  CommentSearchResult,
  UserCommentSearchService,
} from "@ebike-backend/search";

import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-comment")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminCommentController {
  constructor(
    private readonly searchService: UserCommentSearchService,
    private readonly imageDtoService: ProductImageDtoService,
    private readonly updateService: CommentUpdateService,
    private readonly detailService: CommentDetailService,
    private readonly statusService: CommentStatusService,
    private readonly reprocessService: CommentReprocessService,
  ) {}

  @Post("search")
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchThreads(
    @Body() searchParams: CommentSearchParams,
  ): Promise<CommentSearchResult> {
    const result = await this.searchService.search(searchParams);

    this.imageDtoService.updateProductImageUrls(
      (result.items ?? []).flatMap((c) =>
        (c.productReferences ?? []).flatMap((r) =>
          (r.candidates ?? [])
            .map((candidate) => candidate.model)
            .filter((model): model is ProductModel => model != null),
        ),
      ),
    );

    return result;
  }

  @Put(":id")
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateComment(
    @Param("id") id: string,
    @Body() updateDto: UpdateCommentDto,
  ) {
    await this.updateService.updateComment(id, updateDto);

    return this.detailService.getCommentById(id);
  }

  @Put(":id/status")
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateStatus(
    @Param("id") id: string,
    @Body() updateDto: UpdateCommentStatusDto,
    @Req() req: Request,
  ) {
    await this.statusService.updateStatusWithId(
      id,
      updateDto.status,
      (req as any).user.email,
    );

    return this.detailService.getCommentById(id);
  }

  @Post(":id/retry")
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async retry(@Param("id") id: string, @Req() req: Request) {
    await this.reprocessService.retryComment(id, (req as any).user.email);
    return this.detailService.getCommentById(id);
  }

  @Put(":id/toggle-checked")
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async toggleChecked(@Param("id") id: string, @Req() req: Request) {
    await this.statusService.toggleChecked(id, (req as any).user.id);

    return this.detailService.getCommentById(id);
  }
}
