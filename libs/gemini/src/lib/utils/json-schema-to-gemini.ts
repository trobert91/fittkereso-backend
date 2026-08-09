/**
 * Convert an OpenAI-dialect JSON Schema into a shape Gemini's
 * `generationConfig.responseSchema` accepts. Gemini supports a subset of
 * OpenAPI 3.0 — no `additionalProperties`, no `oneOf`/`anyOf`/`$ref`,
 * and types must be lowercase strings.
 *
 * The `AiSchemaValidatorService` runs ajv against the *original* schema
 * after the call, so this converter only needs to make Gemini accept the
 * request — strict shape conformance is enforced post-response.
 */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  'definitions',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'patternProperties',
  'dependencies',
  'not',
  'if',
  'then',
  'else',
  'strict',
]);

export function convertJsonSchemaToGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  if (Array.isArray(schema)) {
    return schema.map(convertJsonSchemaToGemini);
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;

    if (key === 'type' && typeof value === 'string') {
      result[key] = value.toLowerCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, any> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, any>)) {
        props[propKey] = convertJsonSchemaToGemini(propValue);
      }
      result[key] = props;
    } else if (key === 'items') {
      result[key] = convertJsonSchemaToGemini(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
