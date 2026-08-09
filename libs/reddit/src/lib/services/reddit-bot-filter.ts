/**
 * Predicates for filtering out Reddit comments that don't carry user content.
 *
 * Used at every point we ingest comments — the cheap relevance scorer's
 * fetch, the Stage-2 LLM sampler, and the extraction-pipeline tree builder
 * — so the same definitions are applied consistently.
 */

const DELETED_BODY_PATTERNS = new Set(['[deleted]', '[removed]']);

/**
 * Author names that match these patterns are treated as bots. Covers
 * "AutoModerator" (the built-in subreddit bot), explicit "*-bot" naming
 * conventions, and "auto*" prefixes used by other subreddit automation.
 */
const BOT_AUTHOR_PATTERNS = [/bot$/i, /^auto/i];

/**
 * Comments whose body starts with these substrings are subreddit automoderator
 * boilerplate (the canned "thanks for posting" footer, etc.). Lowercased
 * substring match — leading whitespace is tolerated since the body has
 * usually been trimmed by sanitiseText already.
 */
const BOT_BODY_PREFIXES = [
  'thanks for posting on /r/',
  'thanks for posting in /r/',
  'this is a friendly reminder',
  'your post has been removed',
];

export function isDeletedOrRemovedBody(body: string | null | undefined): boolean {
  if (!body) return true;
  return DELETED_BODY_PATTERNS.has(body);
}

export function isBotAuthor(authorName: string | null | undefined): boolean {
  if (!authorName) return false;
  return BOT_AUTHOR_PATTERNS.some((pattern) => pattern.test(authorName));
}

export function isBotBody(body: string | null | undefined): boolean {
  if (!body) return false;
  const lowered = body.trimStart().toLowerCase();
  return BOT_BODY_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/**
 * Returns true when the comment carries real user content — not deleted, not
 * removed, not authored by a bot, not an automoderator boilerplate body. The
 * comment shape is intentionally permissive (`body` / `authorName` /
 * `author.name`) so both raw snoowrap comments and our internal
 * `CommentNode` shape can be passed in.
 */
export function isUserComment(comment: {
  body?: string | null;
  authorName?: string | null;
  author?: { name?: string | null } | string | null;
}): boolean {
  if (isDeletedOrRemovedBody(comment.body)) return false;
  if (isBotBody(comment.body)) return false;
  const authorName =
    comment.authorName ??
    (typeof comment.author === 'string'
      ? comment.author
      : comment.author?.name);
  if (isBotAuthor(authorName)) return false;
  return true;
}
