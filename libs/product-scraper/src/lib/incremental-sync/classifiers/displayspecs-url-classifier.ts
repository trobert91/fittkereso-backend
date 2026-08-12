import { Injectable } from '@nestjs/common';
import { ScrapeQueueName } from '@fittkereso-backend/database';
import {
  UrlClassification,
  UrlClassifier,
} from '../../interfaces/url-classifier.interface';

/**
 * Classifies DisplaySpecifications URLs into scrape queues.
 *
 * Product detail pages follow the pattern:
 *   https://www.displayspecifications.com/<lang>/model/<id>/<slug>
 *
 * Everything else (brand pages, comparison pages, etc.) is skipped.
 */
@Injectable()
export class DisplayspecsUrlClassifier implements UrlClassifier {
  private readonly productDetailPattern =
    /displayspecifications\.com\/\w+\/model\/\w+\//;

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
