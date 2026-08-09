import { ExtractedProduct, Sentiment } from "@ebike-backend/database";

export interface RedditThreadAdminDto {
  id: string;
  redditId: string;
  title: string;
  subReddit: string;
  author: string;
  url: string;
  text: string;
  lastSynced?: Date;

  contexts: RedditContextAdminDto[];
  comments: RedditCommentAdminDto[];
}

export interface RedditContextAdminDto {
  searchQueryId: string;
  searchQuery: string;
  categoryId: string;
  categoryName: string;
  relevanceScore: number;
  processedAt: Date;
  lastRunAt: Date;
}

export interface RedditCommentAdminDto {
  id: string;
  commentId: string;
  parentId?: string;
  authorId?: string;
  authorName?: string;
  url?: string;
  body: string;
  bodyHtml: string | null;
  upvotes: number;
  downvotes: number;
  redditCreationTs?: Date;

  products?: ExtractedProduct[];
  relevant?: boolean;
  extracted?: boolean;
  analyzed?: boolean;
}

export interface ReviewAdminDto {
  username: string;
  review: string;
  sentiment: Sentiment;
  originalProductName?: string;
  originalProductBrand?: string;
}

export interface ProductModelAdminDto {
  brand?: string;
  displayName?: string;
  model?: string;
  description: string;
}

export interface CategoryAdminDto {
  id: string;
  name: string;
  description: string;
}

export interface ProductSpecificationAdminDto {
  id: string;
  key: string;
}
