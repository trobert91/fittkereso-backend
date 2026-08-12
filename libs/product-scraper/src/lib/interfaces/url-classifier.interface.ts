import { ScrapeQueueName } from '@fittkereso-backend/database';

export interface UrlClassification {
  queue: ScrapeQueueName;
  url: string;
}

export interface UrlClassifier {
  classify(url: string): UrlClassification | null;
}
