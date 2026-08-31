import { ProductResolution } from '@fittkereso-backend/database';
import type { ProductResolutionState } from '@fittkereso-backend/database';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { Expose, Transform, Type } from 'class-transformer';

/**
 * One review-queue row plus what can be done to it, so the client never has to
 * re-derive the rules the backend enforces.
 *
 * This is a class rather than an interface on purpose. The API serializes with
 * `strategy: 'excludeAll'` (see `apps/api/src/app.ts`), under which
 * class-transformer only emits properties carrying `@Expose` metadata on a known
 * target type — a plain object literal has no target type, so every key is
 * dropped and the response comes back as `{}`.
 */
export class ResolutionListItem {
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ProductResolution)
  resolution: ProductResolution;

  /** Derived rather than persisted, so it is a plain object and needs the same
   *  exposeAll transform the entity's jsonb columns use. */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  state: ProductResolutionState;

  static of(
    resolution: ProductResolution,
    state: ProductResolutionState,
  ): ResolutionListItem {
    const item = new ResolutionListItem();
    item.resolution = resolution;
    item.state = state;
    return item;
  }
}

/** A page of review-queue rows. Mirrors `BasePageResult`, which lives inside
 *  `libs/search` and is not exported from its barrel. */
export class ResolutionListResult {
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ResolutionListItem)
  items: ResolutionListItem[];

  @Expose({ groups: [SerializeGroup.list] })
  page: number;

  @Expose({ groups: [SerializeGroup.list] })
  pageSize: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalItems: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalPages: number;
}
