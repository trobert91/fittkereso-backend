import { BadRequestException, Injectable } from "@nestjs/common";
import { In } from "typeorm";
import {
  getPrimaryModel,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductReference,
  UserComment,
} from "@ebike-backend/database";
import type { ProductReferenceContext } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { ReferenceRelevanceService } from "@ebike-backend/relevance";
import { ResolutionResultApplierService } from "@ebike-backend/resolution";
import { compact, isUndefined, uniq } from "lodash";
import { UpdateCommentDto } from "../models/update-comment.dto";
import {
  QuoteDto,
  UpdateProductReferenceCandidateDto,
  UpdateProductReferenceDto,
} from "../models";

const SOFTMAX_TAU = 5;

@Injectable()
export class CommentUpdateMapperService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly referenceRelevance: ReferenceRelevanceService,
    private readonly categoryConfig: CategoryConfigService,
    private readonly resolutionApplier: ResolutionResultApplierService,
  ) {}

  public async mapDtoToEntity(
    dto: UpdateCommentDto,
    entity: UserComment,
  ): Promise<UserComment> {
    if (!isUndefined(dto.productReferences)) {
      entity.productReferences = await this.mapProductReferences(
        dto.productReferences,
        entity,
      );
    }

    return entity;
  }

  private async mapProductReferences(
    dtos: UpdateProductReferenceDto[],
    comment: UserComment,
  ): Promise<ProductReference[]> {
    const references = comment.productReferences ?? [];

    const mapped = await Promise.all(
      dtos.map(async (refDto) => {
        const existing = references.find((r) => r.id === refDto.id);
        const ref = existing ?? new ProductReference();
        ref.comment = comment;

        // Preserve or initialize required context
        ref.context =
          ref.context ??
          ({ identification: {}, resolution: {} } as ProductReferenceContext);

        const category =
          ref.productCategory ?? getPrimaryModel(ref)?.productCategory;
        this.validateLabelsAgainstCategory(refDto, category);

        if (!isUndefined(refDto.enabled)) {
          ref.enabled = refDto.enabled;
        }

        if (!isUndefined(refDto.quotes)) {
          ref.quotes = refDto.quotes.map((q, idx) => ({
            id: q.id ?? `q${idx + 1}`,
            text: q.text,
            sentiment: q.sentiment,
            speculative: q.speculative,
            quality: q.quality,
            features: q.features,
            useCases: q.useCases,
            issues: q.issues,
          }));
        }

        if (!isUndefined(refDto.sentiment)) {
          ref.sentiment = refDto.sentiment;
        }

        if (!isUndefined(refDto.intents)) {
          ref.intents = refDto.intents;
        }

        if (!isUndefined(refDto.experience)) {
          ref.experience = refDto.experience;
        }

        if (!isUndefined(refDto.specs)) {
          ref.specs = refDto.specs ?? null;
        }

        // ref.features / ref.useCases hold REFERENCE-LEVEL evidence (LLM emits
        // via STEP 6 of the labeling prompt; admin can edit them here). They
        // are intentionally separate from per-quote evidence — read-side
        // consumers combine ref + quote evidence via collectAllFeatures /
        // collectAllUseCases. Editing quotes does NOT touch these columns.
        if (!isUndefined(refDto.features)) {
          ref.features =
            (refDto.features?.length ?? 0) > 0 ? refDto.features! : null;
        }
        if (!isUndefined(refDto.useCases)) {
          ref.useCases =
            (refDto.useCases?.length ?? 0) > 0 ? refDto.useCases! : null;
        }

        // `candidates` is the more expressive update — it can edit the full
        // set including runner-ups. When present, it wins over `resolvedModel`,
        // which only sets a single primary. Either path is optional; if
        // neither is supplied the candidate set is left untouched.
        if (!isUndefined(refDto.candidates)) {
          await this.applyCandidateSet(ref, refDto.candidates);
        } else if (!isUndefined(refDto.resolvedModel) && refDto.resolvedModel) {
          const model = await this.productRepo.findByIdOrFail(
            refDto.resolvedModel.id,
          );
          await this.resolutionApplier.setPrimaryCandidate(ref, model);
        }

        const relevanceResult = this.referenceRelevance.calculateRelevance(
          ref,
          ref.productCategory ?? getPrimaryModel(ref)?.productCategory,
          comment.body,
          comment.upvotes ?? undefined,
        );
        ref.relevance = relevanceResult.score;

        return ref;
      }),
    );

    return mapped;
  }

  /**
   * Replace the reference's candidate set with the admin-supplied list. Loads
   * the referenced `ProductModel` rows in one batch, computes softmax weights
   * from each candidate's confidence (mirrors `ResolutionResultApplierService.
   * assignSoftmaxWeights`), then hands the snapshot to
   * `copyCandidateSet` — which deletes any existing candidates and writes the
   * new set in a single transaction-safe pass.
   *
   * Empty array clears the candidate set (reference becomes unresolved). When
   * no entry is flagged `isPrimary`, the first entry is promoted to primary
   * to satisfy the partial unique index on `isPrimary = true`.
   */
  private async applyCandidateSet(
    ref: ProductReference,
    dtos: UpdateProductReferenceCandidateDto[],
  ): Promise<void> {
    if (dtos.length === 0) {
      await this.resolutionApplier.copyCandidateSet(ref, []);
      return;
    }

    const modelIds = uniq(dtos.map((c) => c.modelId));
    const models = await this.productRepo.repo.find({
      where: { id: In(modelIds) },
      relations: ["brand", "productCategory"],
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    const missing = modelIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown product model(s) in candidate set: ${missing.join(", ")}`,
      );
    }

    const resolvedModels: {
      model: ProductModel;
      confidence: number;
      isPrimary: boolean;
    }[] = dtos.map((dto) => ({
      model: byId.get(dto.modelId)!,
      confidence: dto.confidence ?? 0,
      isPrimary: dto.isPrimary ?? false,
    }));

    // Promote the first entry if no primary was flagged — the partial unique
    // index on `isPrimary = true` requires exactly one primary per reference.
    if (!resolvedModels.some((entry) => entry.isPrimary)) {
      resolvedModels[0].isPrimary = true;
    }

    const weights = softmax(resolvedModels.map((entry) => entry.confidence));
    const snapshot = resolvedModels.map((entry, index) => ({
      model: entry.model,
      confidence: entry.confidence,
      isPrimary: entry.isPrimary,
      weight: weights[index],
    }));

    await this.resolutionApplier.copyCandidateSet(ref, snapshot);
  }

  private validateLabelsAgainstCategory(
    refDto: UpdateProductReferenceDto,
    category: ProductCategory | undefined,
  ): void {
    const slug = category?.slug;
    if (!slug) return;
    const config = this.categoryConfig.getConfig(slug);
    if (!config) return;

    const allowedFeatures = new Set(
      (config.features ?? []).map((feature) => feature.label),
    );
    const allowedUseCases = new Set(
      (config.useCases ?? []).map((useCase) => useCase.label),
    );

    const featureLabels = collectFeatureLabels(refDto);
    const useCaseLabels = collectUseCaseLabels(refDto);

    const invalidFeatures = featureLabels.filter(
      (label) => !allowedFeatures.has(label),
    );
    const invalidUseCases = useCaseLabels.filter(
      (label) => !allowedUseCases.has(label),
    );

    if (invalidFeatures.length === 0 && invalidUseCases.length === 0) return;

    const parts: string[] = [];
    if (invalidFeatures.length > 0) {
      parts.push(`features: ${uniq(invalidFeatures).join(", ")}`);
    }
    if (invalidUseCases.length > 0) {
      parts.push(`useCases: ${uniq(invalidUseCases).join(", ")}`);
    }
    throw new BadRequestException(
      `Invalid labels for category "${slug}" — ${parts.join("; ")}`,
    );
  }
}

/**
 * Softmax over scores with temperature τ — same shape as
 * `ResolutionResultApplierService.assignSoftmaxWeights`. Single-element input
 * trivially returns [1]; degenerate denom (NaN/0) falls back to uniform
 * weights so the partial unique index stays satisfied.
 */
function softmax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [1];
  const exps = scores.map((score) => Math.exp(score / SOFTMAX_TAU));
  const denom = exps.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(denom) || denom === 0) {
    return scores.map(() => 1 / scores.length);
  }
  return exps.map((value) => value / denom);
}

function collectFeatureLabels(refDto: UpdateProductReferenceDto): string[] {
  const fromQuotes = (refDto.quotes ?? []).flatMap((quote: QuoteDto) =>
    (quote.features ?? []).map((evidence) => evidence.label),
  );
  const fromRef = (refDto.features ?? []).map((evidence) => evidence.label);
  return compact([...fromQuotes, ...fromRef]);
}

function collectUseCaseLabels(refDto: UpdateProductReferenceDto): string[] {
  const fromQuotes = (refDto.quotes ?? []).flatMap((quote: QuoteDto) =>
    (quote.useCases ?? []).map((evidence) => evidence.label),
  );
  const fromRef = (refDto.useCases ?? []).map((evidence) => evidence.label);
  return compact([...fromQuotes, ...fromRef]);
}
