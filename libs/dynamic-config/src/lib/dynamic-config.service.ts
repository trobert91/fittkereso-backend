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

  /** Top-level general settings. */
  get general(): GeneralConfig {
    const data = this.fileLoader.getData();
    return {
      adminContactEmail: data.adminContactEmail,
      amazonAffiliateTag: data.amazonAffiliateTag,
    };
  }

  get debug(): DynamicConfigData['debug'] {
    return this.fileLoader.getData().debug;
  }

  get scheduling(): DynamicConfigData['scheduling'] {
    return this.fileLoader.getData().scheduling;
  }

  get resolution(): DynamicConfigData['resolution'] {
    return this.fileLoader.getData().resolution;
  }

  get enrichment(): DynamicConfigData['enrichment'] {
    return this.fileLoader.getData().enrichment;
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

  get translation(): DynamicConfigData['translation'] {
    return this.fileLoader.getData().translation;
  }
}
