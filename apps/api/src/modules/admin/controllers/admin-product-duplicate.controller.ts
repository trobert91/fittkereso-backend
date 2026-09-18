import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import { ProductModel, UserRole } from '@fittkereso-backend/database';
import { ProductImageDtoService } from '@fittkereso-backend/product';
import {
  ProductDuplicateScanService,
  ProductDuplicateService,
} from '@fittkereso-backend/product-identity';
import {
  ProductDuplicatePairSearchParams,
  ProductDuplicatePairSearchResult,
  ProductDuplicatePairSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { compact } from 'lodash';
import { ProductDuplicateMergeDto } from '../dtos/product-duplicate-merge.dto';
import { ProductDuplicateScanDto } from '../dtos/product-duplicate-scan.dto';

/** The Duplicates page: review pairs, dismiss them, merge them, rescan. */
@Controller('admin-product-duplicate')
@MinRole(UserRole.admin)
export class AdminProductDuplicateController {
  constructor(
    private readonly searchService: ProductDuplicatePairSearchService,
    private readonly duplicateService: ProductDuplicateService,
    private readonly scanService: ProductDuplicateScanService,
    private readonly imageDtoService: ProductImageDtoService,
  ) {}

  @Post('search')
  @MinRole(UserRole.user)
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchDuplicatePairs(
    @Body() searchParams: ProductDuplicatePairSearchParams,
  ): Promise<ProductDuplicatePairSearchResult> {
    const result = await this.searchService.search(searchParams);
    this.imageDtoService.updateProductImageUrls(
      compact(
        (result.items ?? []).flatMap((pair) => [pair.productA, pair.productB]),
      ),
    );
    return result;
  }

  /** "Not duplicates": no later scan reopens the pair — only a person does. */
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismissDuplicatePair(@Param('id') id: string): Promise<void> {
    await this.duplicateService.dismiss(id);
  }

  /** Puts a dismissed pair back in the queue, for a change of mind. */
  @Post(':id/reopen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reopenDuplicatePair(@Param('id') id: string): Promise<void> {
    await this.duplicateService.reopen(id);
  }

  /** Keeps the chosen product of the pair and folds the other one into it. */
  @Post(':id/merge')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async mergeDuplicatePair(
    @Param('id') id: string,
    @Body() body: ProductDuplicateMergeDto,
  ): Promise<ProductModel> {
    return this.duplicateService.mergePair(id, body.survivorProductId);
  }

  /**
   * With a `productId`, re-detects that product now and answers with the pairs
   * written. Without one, starts a scan of the whole catalog in the background
   * — `started: false` means one is already running.
   */
  @Post('scan')
  @SerializeOptions({ strategy: 'exposeAll' })
  async scanForDuplicates(
    @Body() body: ProductDuplicateScanDto,
  ): Promise<{ pairs: number } | { started: boolean }> {
    if (body.productId) {
      return {
        pairs: await this.duplicateService.detect(body.productId, 'scan'),
      };
    }
    return { started: this.scanService.start() };
  }
}
