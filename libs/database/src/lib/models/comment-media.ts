import { compact } from 'lodash';

export interface CommentMedia {
  type: 'image' | 'link';
  url: string;
  content?: string;
}

export function resolveMediaContent(
  media: CommentMedia[] | null | undefined,
): string | null {
  const lines = compact(
    (media ?? []).map((m) => {
      if (!m.content) return null;
      // Images are OCR'd text — splice their content directly into the body so
      // the LLM treats it as part of what the commenter wrote (any spec values
      // visible in an attached image flow through the same SPECS rules as body
      // text). Links keep a label since a URL isn't body content.
      return m.type === 'image' ? m.content : `[Linked: ${m.content}]`;
    }),
  );
  return lines.length > 0 ? lines.join('\n') : null;
}
