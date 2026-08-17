# fittkereso-backend

## Code style

- Favor small, modular services with a single responsibility over large ones. Split classes when they start doing more than one job.
- Avoid code duplication — extract shared logic into a helper/service rather than copy-pasting between call sites.
- Prefer many small, readable classes over few large ones. Optimize for readability and maintainability.
- Use lodash extensively for array/object manipulation (`isUndefined`, `isEmpty`, `compact`, etc.) instead of hand-rolled equivalents — it's already a dependency and used throughout the codebase.

## Database / migrations

- Do **not** write TypeORM migration files for now. The dev config (`apps/api/src/config/config.yaml`) has `sync: true`, so schema changes apply automatically via TypeORM's `synchronize`.
- Once the current phase of development settles, we'll generate one consolidated migration capturing the schema at that point — don't generate incremental ones per change in the meantime.
- Whenever a query needs a field or relation name as a string (`relations: [...]`, `order: {...}`, `select`, etc.), use `nameOf<Entity>('field')` from `@fittkereso-backend/utils` instead of a hardcoded string literal, so renames stay type-checked. For nested/dotted paths, build them as `` `relation.${nameOf<RelationEntity>('field')}` ``.

## Debugging & operational inspection

- Use **Loki** at `http://localhost:3100` as the primary source for debugging running-app behavior — task/pipeline progress, warnings, errors, model calls, cost, resolution decisions, stuck/failed scrape tasks. Query with `query_range` (not `query`). Processing traces are also stored in Loki; query them with `log_type="processing_trace"` for trace-level detail.
- Use the **fittkereso MCP server** (`http://localhost:8090/mcp`) for structured inspection and mutation of entities — products, categories, sellers, product sources, scrape tasks, brands — and for one-off actions (`enqueue_scrape_task`, `create_seller`, `update_product_source`, etc.) instead of writing/running ad hoc scripts. It's the preferred way to create or modify rows during manual testing.
  - If the MCP server's tools aren't showing up as available (e.g. `ToolSearch` finds nothing for it), don't assume the server is down — it may just not be wired into the current session. Verify with a raw HTTP probe first: `curl -s -X POST http://localhost:8090/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`. If that returns a real tool list, call tools directly over HTTP the same way (`method: "tools/call"`, `params: {name, arguments}`) rather than falling back to scripts.
  - When an argument contains non-ASCII characters (Hungarian diacritics, etc.) or heavy escaping (regex patterns), write the JSON-RPC payload to a file with the `Write` tool first and send it via `curl --data-binary @<file>` — inline shell heredocs mangle escaping/encoding.
  - Treat MCP and Loki as complementary, not either/or: MCP for "what does this row look like / make this change happen," Loki for "why did this run behave the way it did." When a scrape task or pipeline step looks stuck or failed via MCP, check Loki next rather than guessing or re-polling blindly.
