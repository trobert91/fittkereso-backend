import { Injectable } from '@nestjs/common';
import { ScrapeQueueName } from '@fittkereso-backend/database';
import {
  UrlClassification,
  UrlClassifier,
} from '../../interfaces/url-classifier.interface';

/**
 * Classifies Arukereso URLs into scrape queues.
 *
 * Product detail pages follow the pattern:
 *   https://www.arukereso.hu/<category-slug>/<brand>/<model>-p<id>/
 *
 * Everything else (category pages, comparison pages, etc.) is skipped.
 */
@Injectable()
export class ArukeresoUrlClassifier implements UrlClassifier {
  private readonly productDetailPattern = /arukereso\.hu\/.+-p\d+\/?/;

  classify(url: string): UrlClassification | null {
    if (this.productDetailPattern.test(url)) {
      return {
        queue: ScrapeQueueName.ScrapeProductDetails,
        url,
      };
    }

    return null;
  }
}
