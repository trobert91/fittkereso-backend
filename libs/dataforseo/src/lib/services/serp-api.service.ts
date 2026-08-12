import { Injectable } from '@nestjs/common';
import { GoogleSerpResponse } from '../models/serp-models';
import { HttpService } from '@nestjs/axios';
import { BaseDataForSeoService } from './base-dataforseo.service';
import { DataForSeoConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class SerpApiService extends BaseDataForSeoService {
  private readonly logger = new CustomLogger(SerpApiService.name);

  constructor(
    httpService: HttpService,
    configService: DataForSeoConfigService,
  ) {
    super(httpService, configService);
  }

  async getLiveGoogleOrganicData({
    keyword,
    locationCode,
    languageCode,
    device,
    group_organic_results = true,
    depth,
  }: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    device: string;
    group_organic_results?: boolean;
    depth: number;
  }): Promise<GoogleSerpResponse> {
    const data = [
      {
        language_code: languageCode,
        location_code: locationCode,
        keyword,
        device,
        group_organic_results,
        depth,
      },
    ];

    const response = await this.post<GoogleSerpResponse>(
      '/serp/google/organic/live/advanced',
      data,
    );

    return response.data;
  }

  protected getLogger(): CustomLogger {
    return this.logger;
  }
}
