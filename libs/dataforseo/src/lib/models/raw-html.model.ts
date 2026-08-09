import { BaseDataForSeoResponse } from './base-dataforseo-response';

export interface RawHtmlResponse extends BaseDataForSeoResponse {
  tasks_count: number;
  tasks_error: number;
  tasks: Task[];
}

interface Task {
  id: string;
  result: RawHtmlResult[];
  status_message: string;
}

interface RawHtmlResult {
  crawl_progress: string;
  crawl_status: CrawlStatus;
  items_count: number;
  items: RawHtmlItem;
}

interface CrawlStatus {
  max_crawl_pages: number;
  pages_in_queue: number;
  pages_crawled: number;
}

interface RawHtmlItem {
  html: string;
}
