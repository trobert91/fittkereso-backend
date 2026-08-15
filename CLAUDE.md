# fittkereso-backend

## Code style

- Favor small, modular services with a single responsibility over large ones. Split classes when they start doing more than one job.
- Avoid code duplication — extract shared logic into a helper/service rather than copy-pasting between call sites.
- Prefer many small, readable classes over few large ones. Optimize for readability and maintainability.
- Use lodash extensively for array/object manipulation (`isUndefined`, `isEmpty`, `compact`, etc.) instead of hand-rolled equivalents — it's already a dependency and used throughout the codebase.

## Database / migrations

- Do **not** write TypeORM migration files for now. The dev config (`apps/api/src/config/config.yaml`) has `sync: true`, so schema changes apply automatically via TypeORM's `synchronize`.
- Once the current phase of development settles, we'll generate one consolidated migration capturing the schema at that point — don't generate incremental ones per change in the meantime.
