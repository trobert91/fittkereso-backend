import type { ThreadPlatform } from './source-enums';

export interface PlatformSearchParams {
  sort: string;
  time: string;
  limit: number;
}

export interface PlatformSearchResult {
  externalId: string;
  title: string;
  url: string;
  author: string;
  text: string;
  commentCount: number;
  score: number;
  createdAt: Date;
  topic: string;
  platform: ThreadPlatform;
}

export interface PlatformSearchHandler {
  readonly platform: ThreadPlatform;

  search(
    keyword: string,
    scope: string | null,
    params: PlatformSearchParams,
  ): Promise<PlatformSearchResult[]>;
}
