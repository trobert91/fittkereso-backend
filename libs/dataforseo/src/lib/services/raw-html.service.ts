import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosResponse } from 'axios';
import { RawHtmlResponse } from '../models/raw-html.model';
import { isEmpty } from 'lodash';
import { BaseDataForSeoService } from './base-dataforseo.service';
import { DataForSeoConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class DataforSeoRawHtmlService extends BaseDataForSeoService {
  private logger = new CustomLogger(DataforSeoRawHtmlService.name);

  constructor(
    httpService: HttpService,
    configService: DataForSeoConfigService,
  ) {
    super(httpService, configService);
  }

  public async getHtml(url: string): Promise<string> {
    let response: RawHtmlResponse | undefined = undefined;
    try {
      this.logger.log(`Crawling is started for ${url}`);
      response = await this.getRawHtmlResponse(url);
      const result = response.tasks[0].result[0].items.html;
      this.logger.log(`Crawling is finished for ${url}`);
      return result;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to crawl url: ${url}. ${JSON.stringify(response)}`,
        error,
      );
      throw error;
    }
  }

  async getRawHtmlResponse(url: string): Promise<RawHtmlResponse> {
    const taskId = await this.createTaskAndReturnTaskId(url);

    const data = [
      {
        id: taskId,
        url,
      },
    ];

    let response: AxiosResponse<RawHtmlResponse>;
    let retries = 0;
    do {
      response = await this.post<RawHtmlResponse>(
        'https://api.dataforseo.com/v3/on_page/raw_html',
        data,
      );
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (!this.isTaskFinished(response.data) && retries < 20);

    if (!this.isTaskFinished(response.data)) {
      throw new Error(`Crawling page ${url} timed out.`);
    }

    return response.data;
  }

  private isTaskFinished(response: RawHtmlResponse): boolean {
    if (isEmpty(response.tasks)) {
      throw new Error('No tasks found');
    }
    const task = response.tasks[0];
    const result = task.result;

    return (
      task.status_message === 'Ok.' &&
      !isEmpty(result) &&
      result[0].crawl_progress === 'finished' &&
      result[0].items_count > 0
    );
  }

  private async createTaskAndReturnTaskId(url: string): Promise<string> {
    const data = [
      {
        // target: domainFromUrl(url),
        target: url,
        max_crawl_pages: 1,
        load_resources: false,
        enable_javascript: false,
        start_url: url,
        store_raw_html: true,
        enable_content_parsing: false,
      },
    ];

    const response = await this.post<RawHtmlResponse>(
      'https://api.dataforseo.com/v3/on_page/task_post',
      data,
    );

    return response.data.tasks[0].id;
  }

  protected getLogger(): CustomLogger {
    return this.logger;
  }
}
