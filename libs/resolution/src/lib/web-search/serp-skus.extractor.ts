import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import { ChatTraceData } from '@fittkereso-backend/debug';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ResolutionContext } from '../models/resolution-context';
import type { SearchEvidence } from '../models/search-evidence';

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number' },
          modelNumbers: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'modelNumbers'],
      },
    },
  },
  required: ['records'],
} as const;

interface ExtractionResponse {
  records: Array<{ index: number; modelNumbers: string[] }>;
}

const SYSTEM_PROMPT = `You are a product-identification expert. Given a Reddit comment's product mention, an optional reference (cheat-sheet) product, and a list of SERP search-result records, extract the model-numbers that appear in each record's title/description/url and look like real SKUs for the input brand.

Rules:
- For each SERP record, return ONLY model numbers that appear literally in that record's title, description, or url.
- Return only model numbers that look like real SKUs for the input brand (mixed letters+digits, hyphens allowed). Marketing names (G80SD), full SKUs (LS32DG802SNXZA), and SKU variations (S32DG80) all qualify when they appear in the SERP text. Pure family names without a SKU suffix (e.g. "OLED G8") do not.
- Do NOT invent or guess model numbers that aren't present in the record's text.
- Do NOT include the input model token itself if it's just the seed of the search.
- Return an empty modelNumbers array for records whose text contains no real SKUs (don't drop the record).
- The records array MUST include every input record, in order, indexed 0..N-1.`;

/**
 * SKU extraction over the **union** of SERP records.
 *
 * One LLM call per `WebRecall.recall()`, regardless of how many SERP queries
 * fired. Each record carries its `queryIntent` so the prompt could surface it
 * (the catalog-resolver and the decision LLM both read it from the record).
 *
 * Mutates each record's `modelNumbers` field in place. Records the LLM omits
 * are populated with an empty array — never undefined.
 */
@Injectable()
export class SerpSkusExtractor {
  constructor(
    private readonly aiChatService: AiChatService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  async extract(
    context: ResolutionContext,
    records: SearchEvidence[],
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<void> {
    if (records.length === 0) return;

    const model =
      this.dynamicConfigService.search?.webSearch?.extractionModel ??
      'deepseek-v4-flash';

    const userMessage = this.buildUserMessage(context, records);

    let parsed: ExtractionResponse;
    try {
      const response = await this.aiChatService.createChat({
        costLabel: 'web_research_serp_extraction',
        schema: EXTRACTION_SCHEMA,
        schemaName: 'web_research_serp_extraction',
        traceCollector,
        logContext,
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 1,
      });
      parsed = JSON.parse(
        response.choices[0].message.content ?? '{"records":[]}',
      ) as ExtractionResponse;
    } catch {
      for (const record of records) record.modelNumbers = [];
      return;
    }

    const byIndex = new Map<number, string[]>();
    for (const entry of parsed.records ?? []) {
      if (typeof entry.index !== 'number') continue;
      byIndex.set(entry.index, dedupe(entry.modelNumbers ?? []));
    }

    for (let index = 0; index < records.length; index++) {
      records[index].modelNumbers = byIndex.get(index) ?? [];
    }
  }

  private buildUserMessage(
    context: ResolutionContext,
    records: SearchEvidence[],
  ): string {
    const input = context.input;
    const reference = context.referenceProduct;
    const parts: string[] = [];

    parts.push('INPUT:');
    if (input.brand) parts.push(`- Input brand: ${input.brand}`);
    if (input.model) parts.push(`- Input model token: ${input.model}`);
    if (input.modelClues?.length) {
      parts.push(
        `- Comment-mentioned model fragments: ${input.modelClues.join(', ')}`,
      );
    }
    if (reference) {
      const refBrand = reference.brand ?? '';
      const refModel = reference.model ?? '';
      parts.push(
        `- Reference product (cheat-sheet): ${refBrand} ${refModel}`.trim(),
      );
      parts.push(
        '  Reference SKU should NOT be returned for any record — it is the search seed, not the answer.',
      );
    }
    parts.push('');
    parts.push('SERP RECORDS:');
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      parts.push(`[${index}] (${record.queryIntent}) ${record.title}`);
      if (record.description) parts.push(`    ${record.description}`);
      parts.push(`    ${record.url}`);
    }
    parts.push('');
    parts.push(
      'Return a "records" array with one entry per SERP record above, indexed 0..N-1.',
    );
    parts.push(
      "Each entry must include `index` (matching the SERP record index) and `modelNumbers` (string[] of SKUs found in that record's text).",
    );
    return parts.join('\n');
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
