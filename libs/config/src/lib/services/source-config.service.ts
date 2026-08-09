import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { uniq } from 'lodash';
import {
  ProductSourceFileConfig,
  ProductSourceIncrementalSyncConfig,
  SourceCategoryConfig,
  productSourceFileConfigSchema,
} from '../models/source-config.types';

@Injectable()
export class SourceConfigService {
  private readonly logger = new Logger(SourceConfigService.name);
  private readonly configCache = new Map<string, ProductSourceFileConfig>();
  private readonly sourcesPath: string;

  constructor() {
    this.sourcesPath = path.join(
      process.cwd(),
      'libs/config/src/lib/product-sources',
    );
    this.loadAll();
  }

  getConfig(sourceType: string): ProductSourceFileConfig | undefined {
    return this.configCache.get(sourceType);
  }

  getBaseUrl(sourceType: string): string | undefined {
    return this.configCache.get(sourceType)?.baseUrl;
  }

  getFullSyncStartUrl(sourceType: string): string | undefined {
    const config = this.configCache.get(sourceType);
    return config?.fullSyncStartUrl ?? config?.baseUrl;
  }

  getCategoryConfig(
    sourceType: string,
    slug: string,
  ): SourceCategoryConfig | undefined {
    return this.configCache.get(sourceType)?.categories?.[slug];
  }

  /** Returns all category slugs where enabled === true (regardless of sourceTitle presence). */
  getEnabledCategorySlugs(sourceType: string): string[] {
    const categories = this.configCache.get(sourceType)?.categories;
    if (!categories) {
      return [];
    }
    return Object.entries(categories)
      .filter(([, config]) => config.enabled)
      .map(([slug]) => slug);
  }

  /**
   * Returns deduplicated source titles for the given slugs (or all enabled slugs
   * if not specified). Slugs without a `sourceTitle` are silently dropped.
   */
  getSourceTitles(sourceType: string, slugs?: string[]): string[] {
    const categories = this.configCache.get(sourceType)?.categories;
    if (!categories) {
      return [];
    }
    const entries = slugs && slugs.length > 0
      ? slugs
          .map((slug) => categories[slug])
          .filter((config): config is SourceCategoryConfig => !!config)
      : Object.values(categories);
    const titles = entries
      .filter((config) => config.enabled)
      .map((config) => config.sourceTitle)
      .filter((title): title is string => !!title);
    return uniq(titles);
  }

  getIncrementalSyncConfig(sourceType: string): ProductSourceIncrementalSyncConfig | undefined {
    return this.configCache.get(sourceType)?.incrementalSync;
  }

  private loadAll(): void {
    if (!fs.existsSync(this.sourcesPath)) {
      this.logger.warn(`Product sources directory not found: ${this.sourcesPath}`);
      return;
    }

    const entries = fs.readdirSync(this.sourcesPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sourceType = entry.name;
      const configPath = path.join(this.sourcesPath, sourceType, 'config.json');
      const config = this.readJsonFile(configPath);

      if (config) {
        this.configCache.set(sourceType, config);
      }
    }

    this.logger.log(`Loaded configs for ${this.configCache.size} product sources`);
  }

  private readJsonFile(filePath: string): ProductSourceFileConfig | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      return productSourceFileConfigSchema.parse(parsed);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to load product source config ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
