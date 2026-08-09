/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppSettingsConfigService } from "../sub-configs/app-settings.config.service";
import {
  MongoConfigService,
  PostgresConfigService,
  DataForSeoConfigService,
  LoggerConfigService,
} from "@ebike-backend/config";

@Injectable()
export class AppConfigService {
  constructor(
    private configService: ConfigService,
    private mongoConfigService: MongoConfigService,
    private postgresConfigService: PostgresConfigService,
    private appSettingsConfigService: AppSettingsConfigService,
    private dataForSeoConfigService: DataForSeoConfigService,
    private loggerConfigService: LoggerConfigService,
  ) {}

  get environment(): string {
    return this.configService.get<string>("environment")!;
  }

  get httpPort(): number {
    return this.configService.get<number>("port") || 3000;
  }

  get serviceType(): string {
    return this.configService.get<string>("service_type")!;
  }

  get mongoConfig(): MongoConfigService {
    return this.mongoConfigService;
  }

  get postgresConfig(): PostgresConfigService {
    return this.postgresConfigService;
  }

  get dataForSeo(): DataForSeoConfigService {
    return this.dataForSeoConfigService;
  }

  get appSettings(): AppSettingsConfigService {
    return this.appSettingsConfigService;
  }

  get loggerConfig(): LoggerConfigService {
    return this.loggerConfigService;
  }
}
