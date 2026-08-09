import { Module } from "@nestjs/common";
import { LoggerModule } from "@ebike-backend/logger";
import { LoggerModule as PinoLoggerModule } from "nestjs-pino";
import { AppConfigModule } from "./modules/app-config/app-config.module";
import { ConfigModule } from "@nestjs/config";
import { ConfigLoader } from "./modules/app-config/loader/config-loader";
import { DatabaseModule } from "@ebike-backend/database";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HttpModule } from "@nestjs/axios";
import { PostgresConfigService } from "@ebike-backend/config";
import { DataSourceOptions, DataSource } from "typeorm";
import { WithLengthColumnType } from "typeorm/driver/types/ColumnTypes";
import { ApiAuthModule } from "./modules/api-auth/api-auth.module";
import { AdminModule } from "./modules/admin/admin.module";
import { ThreadModule } from "@ebike-backend/thread";
import { APP_FILTER } from "@nestjs/core";
import { EntityNotFoundExceptionFilter } from "./exceptions/entity-not-found";
import { MetricsModule } from "@ebike-backend/metrics";
import { ThrottlerModule } from "@nestjs/throttler";
import { TestModule } from "./modules/test/test.module";
import { PublicModule } from "./modules/public/public.module";

@Module({
  imports: [
    AppConfigModule,
    ApiAuthModule,
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvVars: true,
      load: [ConfigLoader],
    }),
    DatabaseModule,
    TypeOrmModule.forRootAsync({
      name: "postgres",
      useExisting: PostgresConfigService,
      dataSourceFactory: async (config: DataSourceOptions | undefined) => {
        if (!config) {
          throw new Error(
            "DataSourceOptions are required for postgres connection",
          );
        }
        const dataSource = new DataSource(config);

        // Add pgvector support
        dataSource.driver.supportedDataTypes.push(
          "vector" as WithLengthColumnType,
        );
        dataSource.driver.withLengthColumnTypes.push(
          "vector" as WithLengthColumnType,
        );

        await dataSource.initialize();

        return dataSource; // or just return `dataSource` in v10+
      },
      inject: [PostgresConfigService],
    }),
    HttpModule,
    LoggerModule,
    PinoLoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        transport:
          process.env.NODE_ENV !== "production"
            ? { target: "pino/file", options: { destination: 1 } }
            : undefined,
        serializers: {
          req: (req) => ({
            method: req.method,
            url: req.url,
          }),
          res: (res) => ({
            statusCode: res.statusCode,
          }),
        },
      },
    }),
    ThrottlerModule.forRoot([
      { name: "autocomplete", ttl: 60_000, limit: 300 },
      { name: "contact", ttl: 600_000, limit: 3 },
      { name: "feedback", ttl: 3_600_000, limit: 5 },
    ]),
    AdminModule,
    ThreadModule,
    MetricsModule,
    PublicModule,
    TestModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: EntityNotFoundExceptionFilter,
    },
  ],
})
export class AppModule {}
