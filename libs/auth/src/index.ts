export * from './lib/auth.module';

export * from './lib/services';
export * from './lib/guards';
export * from './lib/models';
export * from './lib/decorators';
// Re-exported for ergonomics; they live in utils so libs/metrics can use
// them without pulling this lib's Supabase/database graph into other apps.
export { Public, AllowPasswordChangeRequired } from '@fittkereso-backend/utils';
