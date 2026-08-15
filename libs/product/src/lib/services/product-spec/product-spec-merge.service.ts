import { Injectable } from '@nestjs/common';
import {
  ProductModelSource,
  ProductSource,
  ProductSourceRepository,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { chain, defaults, orderBy } from 'lodash';

@Injectable()
export class ProductSpecMergeService {
  private sources: ProductSource[] = [];

  constructor(private readonly sourceRepo: ProductSourceRepository) {}

  public async mergeSpecs(
    sourceSpecs: ProductModelSource[],
  ): Promise<ProductSpecs> {
    await this.loadSourcesIfNeeded(sourceSpecs);

    const mergedSpecs: ProductSpecs = {};

    const specsBySource = sourceSpecs.map((sourceSpec) => ({
      priority:
        this.sources.find((source) => source.id === sourceSpec.source?.id)
          ?.priority ?? 0,
      specs: sourceSpec.specs,
    }));

    const sorted = orderBy(specsBySource, 'priority', 'desc');

    for (const entry of sorted) {
      defaults(mergedSpecs, entry.specs);
    }

    return chain(mergedSpecs)
      .toPairs()
      .sortBy(0)
      .fromPairs()
      .value() as ProductSpecs;
  }

  private async loadSourcesIfNeeded(
    sourceSpecs: ProductModelSource[],
  ): Promise<void> {
    if (!this.isLoadingNeeded(sourceSpecs)) {
      return;
    }

    this.sources = await this.sourceRepo.getAll();
  }

  private isLoadingNeeded(sourceSpecs: ProductModelSource[]): boolean {
    return (
      this.sources.length !== sourceSpecs.length ||
      sourceSpecs.some(
        (spec) =>
          spec.source?.id &&
          !this.sources.find((source) => source.id === spec.source?.id),
      )
    );
  }
}
