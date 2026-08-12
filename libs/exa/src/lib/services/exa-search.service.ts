import { Injectable } from '@nestjs/common';
import Exa from 'exa-js';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ExaConfigService } from '@fittkereso-backend/config';
import { isEmpty } from 'lodash';
import {
  ExaSearchOptions,
  ExaSearchResponse,
  ExaGetContentsOptions,
  ExaContentsResponse,
} from '../models/exa-search.types';

@Injectable()
export class ExaSearchService {
  private readonly logger = new CustomLogger(ExaSearchService.name);
  private readonly exa: Exa;

  constructor(private readonly configService: ExaConfigService) {
    this.exa = new Exa(this.configService.apiKey);
  }

  /**
   * Search the web using Exa's neural/semantic search
   * @param options Search options
   * @returns Search results
   */
  async search(options: ExaSearchOptions): Promise<ExaSearchResponse> {
    const {
      query,
      numResults = 10,
      type = 'auto',
      contents,
      includeDomains,
      excludeDomains,
      startPublishedDate,
      endPublishedDate,
      maxAgeHours,
      category,
      useAutoprompt = false,
    } = options;

    this.logger.debug('Exa search request', {
      query,
      numResults,
      type,
      hasContents: !!contents,
      startPublishedDate,
      endPublishedDate,
    });

    try {
      const searchOptions: any = {
        type,
        numResults,
        useAutoprompt,
      };

      if (contents) {
        searchOptions.contents = contents;
      }

      if (!isEmpty(includeDomains)) {
        searchOptions.includeDomains = includeDomains;
      }

      if (!isEmpty(excludeDomains)) {
        searchOptions.excludeDomains = excludeDomains;
      }

      if (startPublishedDate) {
        searchOptions.startPublishedDate = startPublishedDate;
      }

      if (endPublishedDate) {
        searchOptions.endPublishedDate = endPublishedDate;
      }

      if (maxAgeHours !== undefined) {
        searchOptions.maxAgeHours = maxAgeHours;
      }

      if (category) {
        searchOptions.category = category;
      }

      const result = await this.exa.searchAndContents(query, searchOptions);

      this.logger.debug('Exa search response', {
        resultCount: result.results.length,
        autoDate: result.autoDate,
      });

      return {
        results: result.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          publishedDate: r.publishedDate,
          author: r.author,
          score: r.score,
          id: r.id,
          text: r.text,
          highlights: r.highlights,
          summary: r.summary,
        })),
        autoDate: result.autoDate,
      };
    } catch (error: any) {
      this.logger.error('Exa search failed', error, { query, type });
      throw new Error(`Exa search failed: ${error.message}`);
    }
  }

  /**
   * Get contents for specific URLs
   * @param urls URLs to get contents for
   * @param options Contents options
   * @returns Content results
   */
  async getContents(
    urls: string[],
    options?: ExaGetContentsOptions,
  ): Promise<ExaContentsResponse> {
    this.logger.debug('Exa getContents request', {
      urlCount: urls.length,
      hasText: !!options?.text,
      hasHighlights: !!options?.highlights,
      hasSummary: !!options?.summary,
    });

    try {
      const result = await this.exa.getContents(urls, options as any);

      this.logger.debug('Exa getContents response', {
        resultCount: result.results.length,
      });

      return {
        results: result.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          publishedDate: r.publishedDate,
          author: r.author,
          score: r.score,
          id: r.id,
          text: r.text,
          highlights: r.highlights,
          summary: r.summary,
        })),
      };
    } catch (error: any) {
      this.logger.error('Exa getContents failed', error, {
        urlCount: urls.length,
      });
      throw new Error(`Exa getContents failed: ${error.message}`);
    }
  }
}
