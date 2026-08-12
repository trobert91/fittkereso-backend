import { Injectable, Logger } from '@nestjs/common';
import type {
  ProductCategoryConfig,
  SourceSpecConfig,
} from '@fittkereso-backend/database';
import type {
  SpecDefinitionJsonSchema,
  SpecDefinitionUiSchema,
} from '@fittkereso-backend/database';
import * as fs from 'fs';
import * as path from 'path';

interface CategoryConfigFiles {
  config?: ProductCategoryConfig;
  jsonSchema?: SpecDefinitionJsonSchema;
  uiSchema?: SpecDefinitionUiSchema;
  specMappings?: Record<string, SourceSpecConfig>;
}

@Injectable()
export class CategoryConfigService {
  private readonly logger = new Logger(CategoryConfigService.name);
  private readonly configCache = new Map<string, CategoryConfigFiles>();
  private readonly categoriesPath: string;

  constructor() {
    this.categoriesPath = path.join(
      process.cwd(),
      'libs/config/src/lib/categories',
    );
    this.loadAll();
  }

  // ─── Read Methods ───────────────────────────────────────────────────────────

  getConfig(
    slug: string | null | undefined,
  ): ProductCategoryConfig | undefined {
    if (!slug) return undefined;
    return this.configCache.get(slug)?.config;
  }

  getJsonSchema(
    slug: string | null | undefined,
  ): SpecDefinitionJsonSchema | undefined {
    if (!slug) return undefined;
    return this.configCache.get(slug)?.jsonSchema;
  }

  getUiSchema(
    slug: string | null | undefined,
  ): SpecDefinitionUiSchema | undefined {
    if (!slug) return undefined;
    return this.configCache.get(slug)?.uiSchema;
  }

  getSpecMappings(
    slug: string | null | undefined,
  ): Record<string, SourceSpecConfig> | undefined {
    if (!slug) return undefined;
    return this.configCache.get(slug)?.specMappings;
  }

  getSpecMappingsForSource(
    slug: string | null | undefined,
    source: string,
  ): SourceSpecConfig | undefined {
    if (!slug) return undefined;
    return this.configCache.get(slug)?.specMappings?.[source];
  }

  // ─── Write Methods ──────────────────────────────────────────────────────────

  writeConfig(slug: string, config: ProductCategoryConfig): void {
    this.ensureCategoryDirectory(slug);
    const filePath = path.join(this.categoriesPath, slug, 'config.json');
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
    this.reloadCategory(slug);
  }

  writeJsonSchema(slug: string, schema: SpecDefinitionJsonSchema): void {
    this.ensureCategoryDirectory(slug);
    const filePath = path.join(this.categoriesPath, slug, 'jsonSchema.json');
    fs.writeFileSync(filePath, JSON.stringify(schema, null, 2) + '\n');
    this.reloadCategory(slug);
  }

  writeUiSchema(slug: string, schema: SpecDefinitionUiSchema): void {
    this.ensureCategoryDirectory(slug);
    const filePath = path.join(this.categoriesPath, slug, 'uiSchema.json');
    fs.writeFileSync(filePath, JSON.stringify(schema, null, 2) + '\n');
    this.reloadCategory(slug);
  }

  writeSpecMappings(
    slug: string,
    mappings: Record<string, SourceSpecConfig>,
  ): void {
    this.ensureCategoryDirectory(slug);
    const filePath = path.join(this.categoriesPath, slug, 'specMappings.json');
    fs.writeFileSync(filePath, JSON.stringify(mappings, null, 2) + '\n');
    this.reloadCategory(slug);
  }

  ensureCategoryDirectory(slug: string): void {
    const categoryDirectory = path.join(this.categoriesPath, slug);
    fs.mkdirSync(categoryDirectory, { recursive: true });
  }

  // ─── Cache Management ──────────────────────────────────────────────────────

  reloadCategory(slug: string): void {
    const categoryDirectory = path.join(this.categoriesPath, slug);
    if (!fs.existsSync(categoryDirectory)) {
      this.configCache.delete(slug);
      return;
    }
    this.configCache.set(slug, this.loadCategoryFiles(categoryDirectory));
  }

  getAllSlugs(): string[] {
    return Array.from(this.configCache.keys());
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private loadAll(): void {
    if (!fs.existsSync(this.categoriesPath)) {
      this.logger.warn(
        `Categories directory not found: ${this.categoriesPath}`,
      );
      return;
    }

    const entries = fs.readdirSync(this.categoriesPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const slug = entry.name;
      const categoryDirectory = path.join(this.categoriesPath, slug);
      this.configCache.set(slug, this.loadCategoryFiles(categoryDirectory));
    }

    this.logger.log(`Loaded configs for ${this.configCache.size} categories`);
  }

  private loadCategoryFiles(categoryDirectory: string): CategoryConfigFiles {
    const config = this.readJsonFile<ProductCategoryConfig>(
      path.join(categoryDirectory, 'config.json'),
    );
    return {
      config,
      jsonSchema: this.readJsonFile<SpecDefinitionJsonSchema>(
        path.join(categoryDirectory, 'jsonSchema.json'),
      ),
      uiSchema: this.readJsonFile<SpecDefinitionUiSchema>(
        path.join(categoryDirectory, 'uiSchema.json'),
      ),
      specMappings: this.readJsonFile<Record<string, SourceSpecConfig>>(
        path.join(categoryDirectory, 'specMappings.json'),
      ),
    };
  }

  private readJsonFile<T>(filePath: string): T | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
