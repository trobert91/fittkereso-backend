# fittkereso Backend Instructions

Shared workspace rules live in `../.github/copilot-instructions.md`.

Use this file for backend-specific guidance only.

## Project Context

- This repo is a NestJS monorepo managed by Nx.
- `api` on port `8088` serves public and admin HTTP endpoints.
- `review-collector` on port `8080` processes Reddit threads.
- `product-collector` updates product information.
- `mcp` exposes Model Context Protocol tools on `http://localhost:8090/mcp`.

## Backend Architecture

- Prefer smaller, single-responsibility services over long or multi-purpose services.
- Keep services stateless. All state should come from constructor-injected dependencies.
- Use the repository pattern through existing repositories.
- Respect module boundaries and use `@fittkereso-backend/*` path aliases across libraries.
- Extract a collaborator when a service starts to take on a second concern.

## Backend Configuration

- App YAML config lives under `apps/[app]/src/config/config.yaml`.
- Domain JSON config lives under `libs/config/src/lib/configs/*.json` and is exposed through `DynamicConfigService`.
- Monitoring and trace integrations live alongside the backend libraries and Docker config.

## Commands

```bash
npm ci --legacy-peer-deps
npm run start:api
npm run start:reviews:scheduler
npm run start:products
npm run start:mcp
npx nx serve api
npx nx serve review-collector
npx nx build <project>
npx nx test <project>
npx nx test <project> --testFile=<file>
npm run lint
npm run lint:fix
```

## Code Style

- Do not abbreviate variable names.
- Use lodash helpers such as `isEmpty`, `isNil`, `compact`, `uniq`, `groupBy`, and `keyBy` when they improve clarity, and import them individually.
- Declare explicit return types on public methods.
- Group related parameters into an object when a method would otherwise take three or more arguments.
- Prefer `interface` for object shapes and `type` for unions or intersections.
- Avoid `any`, `as any`, double casts, and non-null assertions on chained access.
- Prefer `??` over `||` for nullish fallbacks.
- Use `enum` for finite status sets that map to database columns.
- Use `Promise.all()` for independent async work.
- Do not use RxJS observables in the service layer.
- Instantiate loggers as `private readonly logger = new CustomLogger(ClassName.name)` and log structured metadata objects.
- Keep module code under `src/lib/`, keep tests co-located as `*.spec.ts`, and keep comments minimal.

## Backend Debugging

- Use Loki at `http://localhost:3100` as the primary source for debugging backend behavior.
- Query application logs through Loki first when investigating pipeline progress, warnings, errors, model calls, cost behavior, or resolution decisions.
- Processing traces are also stored in Loki. Query them directly with `log_type="processing_trace"` when you need trace-level detail or when MCP trace views are not sufficient.
- Prefer MCP for structured inspection of threads, comments, products, reviews, traces, and cost data, but treat it as complementary to Loki rather than a replacement for log inspection.
- If querying Loki directly, use `query_range`, not `query`.
