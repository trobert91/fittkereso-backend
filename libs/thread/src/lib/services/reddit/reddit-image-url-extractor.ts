import { Submission } from "snoowrap";
import { CommentMedia } from "@ebike-backend/database";

/**
 * Extract media from a Reddit submission.
 *
 * Checks (in priority order):
 * 1. `post_hint === 'image'` with `url_overridden_by_dest` or `url`
 * 2. `preview.images[0].source.url` (Reddit-generated preview)
 * 3. `url` if it points to a known image host / has an image extension
 *
 * Returns a list of CommentMedia entries (currently single-image;
 * gallery support via `is_gallery` + `media_metadata` can be added later).
 */
export function extractSubmissionMedia(submission: Submission): CommentMedia[] {
  const sub = submission as any;

  // Path 1: explicit image post
  if (sub.post_hint === "image") {
    const url = sub.url_overridden_by_dest ?? sub.url;
    if (url && isImageUrl(url)) {
      return [{ type: "image", url }];
    }
  }

  // Path 2: Reddit preview (always available for image posts, sometimes for link posts)
  const previewUrl = sub.preview?.images?.[0]?.source?.url;
  if (previewUrl) {
    // Reddit HTML-encodes ampersands in preview URLs
    return [{ type: "image", url: previewUrl.replace(/&amp;/g, "&") }];
  }

  // Path 3: url itself points to an image
  const url: string | undefined = sub.url;
  if (url && isImageUrl(url)) {
    return [{ type: "image", url }];
  }

  return [];
}

/** Check whether a URL points to a known image host or has an image extension. */
export function isImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("i.redd.it") ||
    lower.includes("i.imgur.com") ||
    /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(lower)
  );
}
