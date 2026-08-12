import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductDuplicate } from '../models/product-duplicate.entity';
import { ProductDuplicateDecision } from '../types/product-duplicate-decision';
import type { SpecMatchDetails } from '../types/spec-match-details';

export interface UpsertProductDuplicateParams {
  productAId: string;
  productBId: string;
  decision: ProductDuplicateDecision;
  similarityScore: number;
  specMatchDetails?: SpecMatchDetails;
  pendingReasons?: string[];
}

@Injectable()
export class ProductDuplicateRepository extends BasePostgresRepository<ProductDuplicate> {
  constructor(
    @InjectRepository(ProductDuplicate, 'postgres')
    repository: Repository<ProductDuplicate>,
  ) {
    super(repository, ProductDuplicate);
  }

  async findExistingPair(
    productAId: string,
    productBId: string,
  ): Promise<ProductDuplicate | null> {
    const [orderedA, orderedB] =
      productAId < productBId
        ? [productAId, productBId]
        : [productBId, productAId];

    return this.repo.findOne({
      where: {
        productA: { id: orderedA },
        productB: { id: orderedB },
      },
      relations: [
        nameOf<ProductDuplicate>('productA'),
        nameOf<ProductDuplicate>('productB'),
      ],
    });
  }

  async upsertPair(
    params: UpsertProductDuplicateParams,
  ): Promise<ProductDuplicate | null> {
    const [orderedAId, orderedBId] =
      params.productAId < params.productBId
        ? [params.productAId, params.productBId]
        : [params.productBId, params.productAId];

    const existing = await this.repo.findOne({
      where: {
        productA: { id: orderedAId },
        productB: { id: orderedBId },
      },
    });

    // Don't overwrite terminal decisions
    if (existing) {
      const terminalDecisions: ProductDuplicateDecision[] = [
        ProductDuplicateDecision.rejected,
        ProductDuplicateDecision.auto_merged,
        ProductDuplicateDecision.approved,
      ];
      if (terminalDecisions.includes(existing.decision)) {
        return existing;
      }

      existing.decision = params.decision;
      existing.similarityScore = params.similarityScore;
      existing.specMatchDetails = params.specMatchDetails;
      existing.pendingReasons = params.pendingReasons;
      return this.repo.save(existing);
    }

    const [productAExists, productBExists] = await Promise.all([
      this.repo.manager.exists('ProductModel', { where: { id: orderedAId } }),
      this.repo.manager.exists('ProductModel', { where: { id: orderedBId } }),
    ]);

    if (!productAExists || !productBExists) {
      return null;
    }

    const duplicate = new ProductDuplicate();
    duplicate.productA = { id: orderedAId } as any;
    duplicate.productB = { id: orderedBId } as any;
    duplicate.decision = params.decision;
    duplicate.similarityScore = params.similarityScore;
    duplicate.specMatchDetails = params.specMatchDetails;
    duplicate.pendingReasons = params.pendingReasons;
    return this.repo.save(duplicate);
  }
}
