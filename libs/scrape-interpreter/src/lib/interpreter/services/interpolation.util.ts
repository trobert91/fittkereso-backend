import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

const VAR_TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

// Resolves {{varName}} tokens against ctx.vars. Non-string inputs pass
// through untouched — interpolation only applies to string params like
// regex patterns and URL templates.
export function interpolate(
  value: string,
  ctx: ScrapeExecutionContext,
): string {
  return value.replace(VAR_TOKEN, (_match, name: string) => {
    const resolved = ctx.vars[name];
    return resolved === undefined || resolved === null
      ? ''
      : String(resolved);
  });
}
