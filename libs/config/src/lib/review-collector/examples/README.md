# Phase 2A Configuration Layer - Usage Guide

This guide explains how to use the new configuration system introduced in Phase 2A of the Thread Processor Architecture Review.

## Overview

Phase 2A introduces three configuration services that centralize all hardcoded values:

1. **ProcessorConfigService** - Processor thresholds (relevance scores, max iterations, etc.)
2. **PipelineConfigService** - Pipeline behavior (save strategy, ancestor depth)
3. **CategoryPromptConfigService** - Category-specific prompt configurations

## Configuration Files

### 1. Dynamic Configuration (Runtime)

**File:** [`dynamic-config.example.json`](./dynamic-config.example.json)

Runtime configuration stored in the database via `DynamicConfig` table. Can be updated without code deployment.

**Example usage:**
```json
{
  "processor": {
    "relevance": {
      "minApprovalScore": 50
    },
    "moderation": {
      "minAutoApprovalScore": 80
    }
  },
  "pipeline": {
    "saveStrategy": "on-block",
    "ancestorDepth": 3
  },
  "category": {
    "tvs": {
      "ancestorDepth": 4
    }
  }
}
```

**Update via API:**
```bash
# Update dynamic config
curl -X PATCH http://localhost:9231/api/admin/config \
  -H "Content-Type: application/json" \
  -d @dynamic-config.example.json
```

### 2. Category Prompt Configuration (Database)

**Example files:**
- [`monitors-with-prompt-config.example.json`](./monitors-with-prompt-config.example.json)
- [`tvs-with-prompt-config.example.json`](./tvs-with-prompt-config.example.json)
- [`headphones-with-prompt-config.example.json`](./headphones-with-prompt-config.example.json)
- [`laptops-with-prompt-config.example.json`](./laptops-with-prompt-config.example.json)
- [`cameras-with-prompt-config.example.json`](./cameras-with-prompt-config.example.json)

Category configurations are stored in the `ProductCategory.config` JSONB column.

**Structure:**
```json
{
  "promptConfig": {
    "examples": [...],
    "acceptedSpecs": [...],
    "rejectedTerms": [...],
    "abbreviations": {...},
    "specialInstructions": "..."
  },
  "ancestorDepth": 3
}
```

**Update via API:**
```bash
# Update category config
curl -X PATCH http://localhost:9231/api/admin/categories/:categoryId \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "promptConfig": {
        "abbreviations": {
          "UW": "ultrawide",
          "IPS": "In-Plane Switching"
        },
        "acceptedSpecs": ["inch", "Hz", "ms"],
        "rejectedTerms": ["modes", "settings"]
      },
      "ancestorDepth": 3
    }
  }'
```

## Configuration Services

### ProcessorConfigService

**Purpose:** Centralize processor thresholds

**Injected by:** All processors

**Configuration paths:**
- `processor.relevance.minApprovalScore` (default: 50)
- `processor.relevance.opBypassScore` (default: 1)
- `processor.relevance.webSearchMinRelevance` (default: 50)
- `processor.extraction.minRelevanceForExtraction` (default: 50)
- `processor.extraction.maxQuotesPerProduct` (default: 5)
- `processor.moderation.minAutoApprovalScore` (default: 80)
- `processor.moderation.maxReferenceFlags` (default: 2)
- `processor.pipeline.maxIterations` (default: 16)
- `processor.pipeline.maxParentProducts` (default: 6)

**Example usage in code:**
```typescript
@Injectable()
export class CommentRelevanceProcessor {
  constructor(
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  async process(comment: UserComment): Promise<UserComment> {
    const { minApprovalScore } = this.processorConfig.relevance;

    if (comment.relevance >= minApprovalScore) {
      comment.status = CommentStatus.RELEVANCE_CALCULATED;
    }

    return comment;
  }
}
```

### PipelineConfigService

**Purpose:** Configure pipeline behavior

**Injected by:** CommentPipelineService, CommentPlanProcessor

**Configuration paths:**
- `pipeline.saveStrategy` (default: 'every-step')
  - `'every-step'`: Save after each processor (default, safe)
  - `'on-block'`: Save when processing blocks or ends (60% fewer writes)
  - `'end-only'`: Save only at end (most aggressive, risky)
- `pipeline.ancestorDepth` (default: 3)
- `pipeline.enableBatchSaves` (default: false)
- `category.<categoryId>.ancestorDepth` (category-specific override)
- `category.<categoryId>.saveStrategy` (category-specific override)

**Example usage in code:**
```typescript
@Injectable()
export class CommentPlanProcessor {
  constructor(
    private readonly pipelineConfig: PipelineConfigService,
  ) {}

  async process(thread: Thread, comment: UserComment): Promise<UserComment> {
    const config = this.pipelineConfig.getConfig(thread.productCategory?.id);
    const { ancestorDepth } = config;

    const parentProducts = this.commentContextService.buildParentProductContext(
      ancestors,
      ancestorDepth
    );

    // Use parentProducts in planning...
  }
}
```

### CategoryPromptConfigService

**Purpose:** Load category-specific prompt configurations

**Injected by:** (Future) PromptTemplateService, AbbreviationResolverService

**Configuration structure:**
```typescript
interface CategoryPromptConfig {
  examples?: PromptExample[];
  acceptedSpecs?: string[];
  rejectedTerms?: string[];
  abbreviations?: Record<string, string>;
  specialInstructions?: string;
}
```

**Example usage in code:**
```typescript
@Injectable()
export class AbbreviationResolverService {
  constructor(
    private readonly categoryPromptConfig: CategoryPromptConfigService,
  ) {}

  async resolveAbbreviations(
    commentBody: string,
    categoryId: string
  ): Promise<string> {
    const config = await this.categoryPromptConfig.getConfig(categoryId);
    const { abbreviations } = config;

    // Match abbreviations in comment and build glossary...
    for (const [abbrev, meaning] of Object.entries(abbreviations)) {
      // Resolve abbreviations...
    }
  }
}
```

**Features:**
- **Caching:** 5-minute TTL to minimize database queries
- **Parent inheritance:** Child categories inherit parent configurations
- **Fallback:** Returns empty defaults if category not configured

## Migration Guide

### Before Phase 2A (Hardcoded)
```typescript
// ❌ Old: Magic numbers scattered everywhere
if (comment.relevance >= 50) {
  comment.status = CommentStatus.RELEVANCE_CALCULATED;
}

const ancestors = context.getAncestors(comment);
const parentProducts = this.commentContextService.buildParentProductContext(
  ancestors.slice(0, 2) // Hardcoded depth
);

for (let i = 0; i < 16; i++) { // Magic number
  // Process...
}
```

### After Phase 2A (Configured)
```typescript
// ✅ New: Centralized, configurable values
const { minApprovalScore } = this.processorConfig.relevance;
if (comment.relevance >= minApprovalScore) {
  comment.status = CommentStatus.RELEVANCE_CALCULATED;
}

const config = this.pipelineConfig.getConfig(thread.productCategory?.id);
const parentProducts = this.commentContextService.buildParentProductContext(
  ancestors,
  config.ancestorDepth
);

const { maxIterations } = this.processorConfig.pipeline;
for (let i = 0; i < maxIterations; i++) {
  // Process...
}
```

## Common Configuration Scenarios

### 1. Lower relevance threshold for a specific category
```json
{
  "processor": {
    "relevance": {
      "minApprovalScore": 40
    }
  }
}
```

### 2. Enable aggressive save optimization
```json
{
  "pipeline": {
    "saveStrategy": "on-block"
  }
}
```

### 3. Increase context depth for complex discussions
```json
{
  "category": {
    "tvs": {
      "ancestorDepth": 4
    }
  }
}
```

### 4. Add category-specific abbreviations
```json
{
  "promptConfig": {
    "abbreviations": {
      "FALD": "Full Array Local Dimming",
      "DV": "Dolby Vision"
    },
    "acceptedSpecs": ["4K", "8K", "HDR", "nits"],
    "rejectedTerms": ["app", "streaming", "cable"]
  }
}
```

## Performance Impact

### Database Writes (M1 Goal)
**Before:** 6 saves per comment × 300K comments = 1.8M writes/month
**After (on-block):** 2.4 saves per comment × 300K comments = 720K writes/month
**Reduction:** 60% fewer database writes

### Ancestor Depth (H3 Goal)
**Before:** Fixed 2 levels
**After:** Configurable 2-4 levels per category
**Impact:** 10-15% improvement in pronoun resolution for deep threads

## Testing

Unit tests for all configuration services are located at:
- `apps/review-collector/src/modules/thread-processor/config/*.spec.ts`
- `apps/review-collector/src/modules/ai/config/*.spec.ts`

**Run tests:**
```bash
npx nx test review-collector --testFile=processor-config.service.spec.ts
npx nx test review-collector --testFile=pipeline-config.service.spec.ts
npx nx test review-collector --testFile=category-prompt-config.service.spec.ts
```

## Next Steps (Phase 2B+)

Phase 2A provides the foundation for:
- **Phase 2B:** Prompt versioning and extraction to template files
- **Phase 2C:** Processor registry and factory pattern
- **Phase 2D:** Abbreviation resolution using category configs
- **Phase 2E:** Full implementation of configurable ancestor depth

## Support

For questions or issues:
1. Check the Phase 2 implementation plan: `docs/steps/2_phase2-high-impact-changes-plan.md`
2. Review test files for usage examples
3. Check service implementations in `apps/review-collector/src/modules/`
