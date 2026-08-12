import { Injectable } from '@nestjs/common';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class SearchAnalyticsService {
  private readonly logger = new CustomLogger(SearchAnalyticsService.name);

  logSearchEvent(data: {
    endpoint: 'autocomplete' | 'full';
    query: string;
    resultCount: number;
    hasProductResults: boolean;
    hasCategoryResults?: boolean;
    durationMs: number;
  }): void {
    this.logger.log({
      event: 'search',
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
}
