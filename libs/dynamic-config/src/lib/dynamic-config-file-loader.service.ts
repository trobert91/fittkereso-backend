import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DynamicConfigData } from './models/dynamic-config-data.interface';
import { DynamicConfigValidatorService } from './dynamic-config-validator.service';

@Injectable()
export class DynamicConfigFileLoaderService {
  private readonly logger = new Logger(DynamicConfigFileLoaderService.name);
  private readonly configsPath: string;
  private _data: DynamicConfigData | null = null;

  constructor(private readonly validator: DynamicConfigValidatorService) {
    this.configsPath = path.join(process.cwd(), 'libs/config/src/lib/configs');
    this._data = this.loadAll();
  }

  getData(): DynamicConfigData {
    if (!this._data) {
      throw new Error('Dynamic config not loaded');
    }
    return this._data;
  }

  private loadAll(): DynamicConfigData {
    const general = this.readJsonFile<Record<string, unknown>>('general.json') ?? {};
    const scheduling = this.readJsonFile<DynamicConfigData['scheduling']>('scheduling.json');
    const resolution = this.readJsonFile<DynamicConfigData['resolution']>('resolution.json');
    const openai = this.readJsonFile<DynamicConfigData['openai']>('openai.json');
    const gemini = this.readJsonFile<DynamicConfigData['gemini']>('gemini.json');
    const claude = this.readJsonFile<DynamicConfigData['claude']>('claude.json');
    const webSearch = this.readJsonFile<DynamicConfigData['webSearch']>('webSearch.json');
    const translation = this.readJsonFile<DynamicConfigData['translation']>('translation.json');

    const debugFromGeneral = general['debug'] as { traceEnabled?: boolean } | undefined;

    const data: DynamicConfigData = {
      ...(general['adminContactEmail'] !== undefined && general['adminContactEmail'] !== '' && { adminContactEmail: general['adminContactEmail'] as string }),
      ...(general['amazonAffiliateTag'] !== undefined && general['amazonAffiliateTag'] !== '' && { amazonAffiliateTag: general['amazonAffiliateTag'] as string }),
      ...(debugFromGeneral && { debug: debugFromGeneral }),
      ...(scheduling && { scheduling }),
      ...(resolution && { resolution }),
      ...(openai && { openai }),
      ...(gemini && { gemini }),
      ...(claude && { claude }),
      ...(webSearch && { webSearch }),
      ...(translation && { translation }),
    };

    this.validator.validateOrThrowError(data);
    this.logger.log('Dynamic config loaded from files');

    return data;
  }

  private readJsonFile<T = unknown>(filename: string): T | null {
    const filePath = path.join(this.configsPath, filename);
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Config file not found: ${filePath}`);
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      throw new Error(
        `Failed to parse config file ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
