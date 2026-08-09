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
    const processor = this.readJsonFile<DynamicConfigData['processor']>('processor.json');
    const scheduling = this.readJsonFile<DynamicConfigData['scheduling']>('scheduling.json');
    const rating = this.readJsonFile<DynamicConfigData['rating']>('rating.json');
    const review = this.readJsonFile<DynamicConfigData['review']>('review.json');
    const resolution = this.readJsonFile<DynamicConfigData['resolution']>('resolution.json');
    const relevance = this.readJsonFile<DynamicConfigData['relevance']>('relevance.json');
    const scoring = this.readJsonFile<DynamicConfigData['scoring']>('scoring.json');
    const openai = this.readJsonFile<DynamicConfigData['openai']>('openai.json');
    const gemini = this.readJsonFile<DynamicConfigData['gemini']>('gemini.json');
    const claude = this.readJsonFile<DynamicConfigData['claude']>('claude.json');
    const webSearch = this.readJsonFile<DynamicConfigData['webSearch']>('webSearch.json');
    const preprocessing = this.readJsonFile<DynamicConfigData['preprocessing']>('preprocessing.json');
    const translation = this.readJsonFile<DynamicConfigData['translation']>('translation.json');
    const keywordResearch = this.readJsonFile<DynamicConfigData['keywordResearch']>('keywordResearch.json');

    const debugFromGeneral = general['debug'] as { traceEnabled?: boolean } | undefined;

    const data: DynamicConfigData = {
      threadProcessingPerDay: (general['threadProcessingPerDay'] as number) ?? 0,
      redditSearchThreadLimit: (general['redditSearchThreadLimit'] as number) ?? 30,
      redditThreadExpiryInDays: (general['redditThreadExpiryInDays'] as number) ?? 180,
      ...(general['adminContactEmail'] !== undefined && general['adminContactEmail'] !== '' && { adminContactEmail: general['adminContactEmail'] as string }),
      ...(general['amazonAffiliateTag'] !== undefined && general['amazonAffiliateTag'] !== '' && { amazonAffiliateTag: general['amazonAffiliateTag'] as string }),
      ...(debugFromGeneral && { debug: debugFromGeneral }),
      ...(processor && { processor }),
      ...(scheduling && { scheduling }),
      ...(rating && { rating }),
      ...(review && { review }),
      ...(resolution && { resolution }),
      ...(relevance && { relevance }),
      ...(scoring && { scoring }),
      ...(openai && { openai }),
      ...(gemini && { gemini }),
      ...(claude && { claude }),
      ...(webSearch && { webSearch }),
      ...(preprocessing && { preprocessing }),
      ...(translation && { translation }),
      ...(keywordResearch && { keywordResearch }),
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
