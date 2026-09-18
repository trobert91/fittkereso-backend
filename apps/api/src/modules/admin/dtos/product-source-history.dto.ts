import { Expose, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ProductSourceAction,
  ProductSourceActor,
  ProductSourceVersion,
} from '@fittkereso-backend/database';
import { AuthenticatedUser } from '@fittkereso-backend/auth';
import { SerializeGroup } from '@fittkereso-backend/utils';

/** Paging for the version history and the action timeline. */
export class ProductSourceHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  // Capped rather than unbounded: every version row carries a whole config,
  // so an uncapped page is an easy way to ask for megabytes by accident.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

/**
 * The wrappers carry @Expose like BasePageResult does, rather than relying on
 * the route's `exposeAll` alone: the global serializer runs excludeAll, and a
 * plain undecorated object comes back as `{}`. Decorating them means the
 * response does not depend on remembering the strategy at every route.
 */
export class ProductSourceVersionListDto {
  @Expose({ groups: [SerializeGroup.list] })
  items: ProductSourceVersion[];

  @Expose({ groups: [SerializeGroup.list] })
  total: number;
}

export class ProductSourceActionListDto {
  @Expose({ groups: [SerializeGroup.list] })
  items: ProductSourceAction[];

  @Expose({ groups: [SerializeGroup.list] })
  total: number;
}

/**
 * The authenticated caller as a history actor.
 *
 * `AuthenticatedUser.id` is the LOCAL app_user primary key — UserAuthService
 * resolves the Supabase token to the local row and puts that id here — so it
 * is exactly what the actorUser foreign key needs. The email travels alongside
 * it and is frozen onto the row, so the history still names who acted after
 * the account is deleted and the key goes null.
 */
export function actorFor(user: AuthenticatedUser | undefined): ProductSourceActor {
  if (!user) {
    // Only reachable if the route's guard were removed; recorded honestly
    // rather than attributed to nobody in particular.
    return { type: 'system', label: 'unauthenticated' };
  }

  return { type: 'user', userId: user.id, label: user.email };
}
