import { Injectable } from '@nestjs/common';
import { DynamicConfigData, GeneralConfig, ProductSearchAgentConfig } from './models/dynamic-config-data.interface';
import { DynamicConfigFileLoaderService } from './dynamic-config-file-loader.service';

@Injectable()
export class DynamicConfigService {
  constructor(private readonly fileLoader: DynamicConfigFileLoaderService) {}

  /** Full config object — for admin/MCP dump endpoints that need the entire config. */
  get config(): DynamicConfigData {
    return this.fileLoader.getData();
  }

  /** Top-level general settings (threadProcessingPerDay, redditSearchThreadLimit, etc.) */
  get general(): GeneralConfig {
    const data = this.fileLoader.getData();
    return {
      threadProcessingPerDay: data.threadProcessingPerDay,
      redditSearchThreadLimit: data.redditSearchThreadLimit,
      redditThreadExpiryInDays: data.redditThreadExpiryInDays,
      adminContactEmail: data.adminContactEmail,
      amazonAffiliateTag: data.amazonAffiliateTag,
    };
  }

  get processor(): DynamicConfigData['processor'] {
    return this.fileLoader.getData().processor;
  }

  get debug(): DynamicConfigData['debug'] {
    return this.fileLoader.getData().debug;
  }

  get scheduling(): DynamicConfigData['scheduling'] {
    return this.fileLoader.getData().scheduling;
  }

  get rating(): DynamicConfigData['rating'] {
    return this.fileLoader.getData().rating;
  }

  get review(): DynamicConfigData['review'] {
    return this.fileLoader.getData().review;
  }

  get resolution(): DynamicConfigData['resolution'] {
    return this.fileLoader.getData().resolution;
  }

  get enrichment(): DynamicConfigData['enrichment'] {
    return this.fileLoader.getData().enrichment;
  }

  get relevance(): DynamicConfigData['relevance'] {
    return this.fileLoader.getData().relevance;
  }

  get scoring(): DynamicConfigData['scoring'] {
    return this.fileLoader.getData().scoring;
  }

  get search(): ProductSearchAgentConfig | undefined {
    return this.fileLoader.getData().resolution?.search;
  }

  get openai(): DynamicConfigData['openai'] {
    return this.fileLoader.getData().openai;
  }

  get gemini(): DynamicConfigData['gemini'] {
    return this.fileLoader.getData().gemini;
  }

  get claude(): DynamicConfigData['claude'] {
    return this.fileLoader.getData().claude;
  }

  get openrouter(): DynamicConfigData['openrouter'] {
    return this.fileLoader.getData().openrouter;
  }

  get deepseek(): DynamicConfigData['deepseek'] {
    return this.fileLoader.getData().deepseek;
  }

  get webSearch(): DynamicConfigData['webSearch'] {
    return this.fileLoader.getData().webSearch;
  }

  get preprocessing(): DynamicConfigData['preprocessing'] {
    return this.fileLoader.getData().preprocessing;
  }

  get reprocessing(): DynamicConfigData['reprocessing'] {
    return this.fileLoader.getData().reprocessing;
  }

  get translation(): DynamicConfigData['translation'] {
    return this.fileLoader.getData().translation;
  }

  get keywordResearch(): DynamicConfigData['keywordResearch'] {
    return this.fileLoader.getData().keywordResearch;
  }
}
