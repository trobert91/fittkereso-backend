/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { entityList } from '@fittkereso-backend/database';
import { Migration1741610400000 } from '../migrations/1741610400000-remove-review-visible';
import { AddTrigramIndexes1735550000000 } from '../migrations/1756502843829-add-trigram-indexes';
import { AddEmbeddingVectorToProductModel1736720000000 } from '../migrations/1757861707507-product-embedding';
import { Brand1758983295970 } from '../migrations/1758983295970-brand';
import { Migration1766068724536 } from '../migrations/1766068724536-add-thread-trigram-index';
import { Migration1766329531585 } from '../migrations/1766329531585-add-comment-trigram-index';
import { WebSearchCacheTrigram1771189377000 } from '../migrations/1771189377000-web-search-cache-trigram';
import { Migration1773158454666 } from '../migrations/1773158454666-add-product-reference-specs';
import { Migration1779000000000 } from '../migrations/1779000000000-sentiment-strong-values';
import { Migration1779500000000 } from '../migrations/1779500000000-add-review-filter-indexes';
import { Migration1780000000000 } from '../migrations/1780000000000-thread-status-rename';
import { Migration1780100000000 } from '../migrations/1780100000000-keyword-research-refactor';
import { Migration1780200000000 } from '../migrations/1780200000000-drop-thread-comment-review-tables';

@Injectable()
export class PostgresConfigService implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService) {}
  createTypeOrmOptions(): TypeOrmModuleOptions | Promise<TypeOrmModuleOptions> {
    let config: TypeOrmModuleOptions = {
      type: 'postgres',
      name: 'postgres',
      host: this.host,
      port: this.port,
      username: this.user,
      password: this.password,
      database: this.database,
      entities: entityList,
      synchronize: this.sync,
      logging: this.logging,
      autoLoadEntities: true,
      migrations: this.migrationsEnabled
        ? [
            Migration1741610400000,
            AddTrigramIndexes1735550000000,
            AddEmbeddingVectorToProductModel1736720000000,
            Brand1758983295970,
            Migration1766068724536,
            Migration1766329531585,
            WebSearchCacheTrigram1771189377000,
            Migration1773158454666,
            Migration1779000000000,
            Migration1779500000000,
            Migration1780000000000,
            Migration1780100000000,
            Migration1780200000000,
          ]
        : [],
    };

    if (this.ssl) {
      config = {
        ...config,
        ssl: true,
        extra: {
          ssl: {
            rejectUnauthorized: false,
          },
        },
      };
    }

    return config;
  }
  get host(): string {
    return this.configService.get<string>('postgres.host')!;
  }
  get port(): number {
    return this.configService.get<number>('postgres.port')!;
  }
  get user(): string {
    return this.configService.get<string>('postgres.user')!;
  }
  get password(): string {
    return this.configService.get<string>('postgres.password')!;
  }
  get database(): string {
    return this.configService.get<string>('postgres.database')!;
  }
  get sync(): boolean {
    return this.configService.get<boolean>('postgres.sync')!;
  }
  get ssl(): boolean {
    return this.configService.get<boolean>('postgres.ssl')!;
  }
  get logging(): boolean {
    return this.configService.get<boolean>('postgres.logging')!;
  }

  get migrationsEnabled(): boolean {
    return this.configService.get<boolean>('postgres.run_migrations')!;
  }
}
