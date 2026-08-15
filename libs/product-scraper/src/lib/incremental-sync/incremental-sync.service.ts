import { Injectable } from '@nestjs/common';
import { ProductSource, ScrapeTask } from '@fittkereso-backend/database';
import { ExaSearchService } from '@fittkereso-backend/exa';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { CustomLogger } from '@fittkereso-backend/logger';
import { IncrementalSyncMetricsService } from '@fittkereso-backend/metrics';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { compact, isEmpty, uniq } from 'lodash';
import { ScrapeUrlDeduplicationService } from '../product-scraper';

const DEFAULT_NUM_RESULTS = 40;
const DEFAULT_LOOKBACK_DAYS = 30;

@Injectable()
export class IncrementalSyncService {
  private readonly logger = new CustomLogger(IncrementalSyncService.name);

  constructor(
    private readonly exaSearchService: ExaSearchService,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly scrapeUrlDedup: ScrapeUrlDeduplicationService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly incrementalSyncMetrics: IncrementalSyncMetricsService,
  ) {}

  async sync(source: ProductSource): Promise<void> {
    const startTime = Date.now();
    const config = source.config;
    const sourceName = source.name;

    const baseUrl = config.baseUrl;
    if (!baseUrl) {
      this.logger.warn(`No baseUrl configured for source: ${sourceName}`);
      return;
    }

    const incrementalConfig = config.incrementalSync;
    const searchKeywords = incrementalConfig?.searchKeywords;
    if (isEmpty(searchKeywords)) {
      this.logger.warn(
        `No incremental search keywords configured for source: ${sourceName}`,
      );
      return;
    }

    if (!incrementalConfig?.urlClassify) {
      this.logger.warn(`No URL classifier config for source: ${sourceName}`);
      return;
    }

    const domain = this.extractDomain(baseUrl);
    const numResults = incrementalConfig.numResults ?? DEFAULT_NUM_RESULTS;
    const startPublishedDate = this.getStartDate(source.lastIncrementalSyncAt);

    this.logger.debug(`Starting incremental sync for ${sourceName}`, {
      domain,
      keywords: searchKeywords,
      startPublishedDate,
      numResults,
    });

    try {
      // Search for each keyword and collect all result URLs
      const allUrls: string[] = [];

      for (const keyword of searchKeywords!) {
        this.incrementalSyncMetrics.keywordSearched(sourceName);
        const exaStart = Date.now();
        try {
          const response = await this.exaSearchService.search({
            query: keyword,
            type: 'keyword',
            numResults,
            includeDomains: [domain],
            startPublishedDate,
          });

          const urls = compact(response.results.map((result) => result.url));
          allUrls.push(...urls);

          this.incrementalSyncMetrics.exaApiCallCompleted();
          this.incrementalSyncMetrics.recordExaApiDuration(
            (Date.now() - exaStart) / 1000,
          );
          this.incrementalSyncMetrics.recordUrlsDiscovered(
            sourceName,
            urls.length,
          );

          this.logger.debug(
            `Exa search for "${keyword}" returned ${urls.length} results`,
          );
        } catch (error: unknown) {
          this.incrementalSyncMetrics.exaApiCallFailed();
          this.incrementalSyncMetrics.recordExaApiDuration(
            (Date.now() - exaStart) / 1000,
          );
          this.logger.warn(
            `Exa search failed for keyword "${keyword}", continuing with remaining keywords`,
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }

      // Classify URLs — only keep product detail pages
      const classifiedUrls = compact(
        uniq(allUrls).map((url) => this.interpreter.classifyIncrementalUrl(url, config)),
      );

      this.incrementalSyncMetrics.recordUrlsClassified(
        sourceName,
        classifiedUrls.length,
      );

      if (isEmpty(classifiedUrls)) {
        this.logger.debug('No product detail URLs found after classification');
        this.incrementalSyncMetrics.syncCompleted(sourceName);
        this.incrementalSyncMetrics.recordSyncDuration(
          sourceName,
          (Date.now() - startTime) / 1000,
        );
        return;
      }

      this.logger.debug(
        `Classified ${classifiedUrls.length} URLs as product detail pages`,
      );

      // Deduplicate against existing product sources and pending/processing tasks
      const urlsToCheck = classifiedUrls.map(
        (classification) => classification.url,
      );
      const existingUrls =
        await this.scrapeUrlDedup.findDuplicateUrls(urlsToCheck);

      this.incrementalSyncMetrics.recordUrlsDeduplicated(
        sourceName,
        existingUrls.size,
      );

      const newClassifications = classifiedUrls.filter(
        (classification) => !existingUrls.has(classification.url),
      );

      if (isEmpty(newClassifications)) {
        this.logger.debug(
          'All discovered URLs already have pending/processing tasks',
        );
        this.incrementalSyncMetrics.syncCompleted(sourceName);
        this.incrementalSyncMetrics.recordSyncDuration(
          sourceName,
          (Date.now() - startTime) / 1000,
        );
        return;
      }

      // Create scrape tasks for new URLs
      const tasks = newClassifications.map((classification) => {
        const task = new ScrapeTask();
        task.queue = classification.queue;
        task.source = source;
        task.url = classification.url;
        return task;
      });

      await this.scrapeTaskPublisher.addTasks(tasks);

      this.incrementalSyncMetrics.recordTasksCreated(sourceName, tasks.length);
      this.incrementalSyncMetrics.syncCompleted(sourceName);
      this.incrementalSyncMetrics.recordSyncDuration(
        sourceName,
        (Date.now() - startTime) / 1000,
      );

      this.logger.log(
        `Incremental sync for ${sourceName}: created ${tasks.length} new scrape tasks (${existingUrls.size} duplicates skipped)`,
      );
    } catch (error: unknown) {
      this.incrementalSyncMetrics.syncFailed(sourceName);
      this.incrementalSyncMetrics.recordSyncDuration(
        sourceName,
        (Date.now() - startTime) / 1000,
      );
      throw error;
    }
  }

  private extractDomain(baseUrl: string): string {
    const url = new URL(baseUrl);
    return url.hostname;
  }

  private getStartDate(lastIncrementalSyncAt?: Date): string {
    const date =
      lastIncrementalSyncAt ??
      new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return date.toISOString();
  }
}
