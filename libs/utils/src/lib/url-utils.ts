export const domainFromUrl = (url: string): string => {
  const urlObject = new URL(url);
  return urlObject.hostname.replace('www.', '');
};

const PLATFORM_BASE_URLS: Record<string, string> = {
  reddit: 'https://reddit.com',
  youtube: 'https://youtube.com',
};

export const resolveExternalUrl = (
  relativeUrl: string | null | undefined,
  platform: string | null | undefined,
): string | null => {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http')) return relativeUrl;
  const base = platform ? (PLATFORM_BASE_URLS[platform] ?? null) : null;
  return base ? `${base}${relativeUrl}` : relativeUrl;
};
