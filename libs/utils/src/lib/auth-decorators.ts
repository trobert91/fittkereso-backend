import { SetMetadata } from '@nestjs/common';

/**
 * Route-level auth opt-outs.
 *
 * These live in utils rather than in the auth lib on purpose: libs/metrics
 * needs @Public on its Prometheus controller, and libs/metrics is imported by
 * apps/product-collector. Declaring them in libs/auth would drag that lib's
 * Supabase and database graph into the collector's build for the sake of a
 * decorator. libs/utils has no dependencies and is already imported
 * everywhere, so it costs nothing.
 *
 * SetMetadata rather than Reflector.createDecorator: createDecorator produces
 * a decorator that must be called with a value (@Public(true)), or needs a
 * transform to make a bare @Public() work. The guards read these with
 * getAllAndOverride so they apply at either class or handler level.
 */

export const IS_PUBLIC_KEY = 'isPublic';

/** Exempts a route from authentication entirely. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_PASSWORD_CHANGE_REQUIRED_KEY = 'allowPasswordChangeRequired';

/**
 * Lets an authenticated route stay reachable while the caller is still held
 * on a temporary password. Only the routes that lift the hold - or let them
 * leave - should carry this.
 */
export const AllowPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true);
