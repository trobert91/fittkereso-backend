# Exa.ai Integration Library

This library provides integration with [Exa.ai](https://exa.ai) neural/semantic search API for the fittkereso backend.

## Features

- **Neural/Semantic Search**: Advanced AI-powered web search
- **Temporal Filtering**: Search with date constraints using `startPublishedDate` and `endPublishedDate`
- **Content Extraction**: Get full page text, highlights, or summaries
- **TypeScript Support**: Fully typed API interfaces

## Installation

The library is already installed as part of the monorepo. The required npm package `exa-js` is included in dependencies.

## Configuration

### Option 1: Environment Variable (Recommended)

Set the `EXA_API_KEY` environment variable:

```bash
export EXA_API_KEY="your_api_key_here"
```

### Option 2: Config YAML

Add to your application's `config.yaml`:

```yaml
exa:
  api_key: your_api_key_here
  api_url: https://api.exa.ai # Optional, defaults to https://api.exa.ai
```

## Usage

### Basic Setup

Import the `ExaModule` in your application module:

```typescript
import { Module } from "@nestjs/common";
import { ExaModule } from "@fittkereso-backend/exa";

@Module({
  imports: [ExaModule],
  // ...
})
export class YourModule {}
```

### Search Examples

```typescript
import { ExaSearchService } from "@fittkereso-backend/exa";

@Injectable()
export class YourService {
  constructor(private readonly exaSearch: ExaSearchService) {}

  async searchProducts(productName: string, beforeDate: Date) {
    const results = await this.exaSearch.search({
      query: productName,
      numResults: 10,
      type: "auto", // or 'neural' for semantic search
      endPublishedDate: beforeDate.toISOString(),
      contents: {
        highlights: {
          maxCharacters: 2000,
        },
      },
    });

    return results.results;
  }
}
```

### Search Types

- **`auto`**: Balanced relevance and speed (~1 second) - **Recommended**
- **`neural`**: Semantic/neural search for better intent understanding
- **`keyword`**: Traditional keyword matching

### Content Options

Choose ONE content type:

1. **Text** (full page content):

```typescript
contents: {
  text: {
    maxCharacters: 20000,
  },
}
```

2. **Highlights** (snippets - more cost-effective):

```typescript
contents: {
  highlights: {
    maxCharacters: 2000,
  },
}
```

3. **Summary** (AI-generated summary):

```typescript
contents: {
  summary: true,
}
```

### Temporal Filtering

Filter results by publication date:

```typescript
const results = await exaSearch.search({
  query: "LG 27GR83Q-B gaming monitor",
  startPublishedDate: "2023-01-01T00:00:00Z",
  endPublishedDate: "2024-01-15T00:00:00Z",
  numResults: 10,
});
```

### Domain Filtering

Include or exclude specific domains:

```typescript
// Only search specific domains
const results = await exaSearch.search({
  query: "laptop reviews",
  includeDomains: ["rtings.com", "reddit.com"],
  numResults: 10,
});

// Exclude domains
const results = await exaSearch.search({
  query: "laptop reviews",
  excludeDomains: ["pinterest.com"],
  numResults: 10,
});
```

**Note:** Cannot use `includeDomains` and `excludeDomains` together.

## API Reference

### `ExaSearchService.search(options: ExaSearchOptions)`

Main search method.

**Parameters:**

- `query` (string, required): Search query
- `numResults` (number, optional): Results to return (1-20, default: 10)
- `type` (ExaSearchType, optional): Search type ('auto', 'neural', 'keyword')
- `contents` (ExaContentsOptions, optional): Content extraction options
- `startPublishedDate` (string, optional): ISO 8601 date string
- `endPublishedDate` (string, optional): ISO 8601 date string
- `includeDomains` (string[], optional): Domains to include
- `excludeDomains` (string[], optional): Domains to exclude
- `maxAgeHours` (number, optional): Maximum cache age in hours
- `category` (string, optional): Category filter
- `useAutoprompt` (boolean, optional): Let Exa optimize query

**Returns:** `Promise<ExaSearchResponse>`

### `ExaSearchService.getContents(options: ExaContentsOptions)`

Get contents for specific URLs.

**Parameters:**

- `urls` (string[], required): URLs to fetch contents for
- `text`, `highlights`, `summary` (optional): Same as search

**Returns:** `Promise<ExaContentsResponse>`

## Integration with Product Resolution

The Exa library is designed to work with the unified ProductWebSearchService:

```typescript
import { ExaSearchService } from "@fittkereso-backend/exa";
import { WebSearchProvider } from "@fittkereso-backend/database";

// Provider selection based on comment relevance
const provider =
  relevance >= 0.8 ? WebSearchProvider.Exa : WebSearchProvider.DataForSEO;

if (provider === WebSearchProvider.Exa) {
  const results = await exaSearchService.search({
    query: keyword,
    endPublishedDate: searchDate.toISOString(),
    numResults: 10,
    type: "neural",
    contents: {
      text: { maxCharacters: 10000 },
      summary: true,
    },
  });
}
```

## Cost Optimization

- Use `highlights` instead of `text` when full content isn't needed
- Set `maxCharacters` limits to control token usage
- Use `type: 'auto'` for balanced cost/quality
- Cache results in database (see ProductWebSearchService)

## Resources

- [Exa.ai Documentation](https://docs.exa.ai)
- [Exa.ai Dashboard](https://dashboard.exa.ai)
- [exa-js npm package](https://www.npmjs.com/package/exa-js)
