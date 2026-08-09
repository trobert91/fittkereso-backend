import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, DataSourceOptions } from "typeorm";
import { WithLengthColumnType } from "typeorm/driver/types/ColumnTypes";

import { AppConfigModule } from "./modules/app-config/app-config.module";
import { ConfigLoader } from "./modules/app-config/loader/config-loader";
import { DatabaseModule } from "@ebike-backend/database";
import { LoggerModule } from "@ebike-backend/logger";
import { AiModule } from "@ebike-backend/ai";
import { ThreadModule } from "@ebike-backend/thread";
import { PostgresConfigService } from "@ebike-backend/config";

import { BenchmarkRunnerModule } from "./modules/runner/benchmark-runner.module";

@Module({
  imports: [
    AppConfigModule,
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
        const dataSource = new DataSource(config);

        // Add pgvector support
        dataSource.driver.supportedDataTypes.push(
          "vector" as WithLengthColumnType,
        );
        dataSource.driver.withLengthColumnTypes.push(
          "vector" as WithLengthColumnType,
        );

        await dataSource.initialize();

        return dataSource;
      },
      inject: [PostgresConfigService],
    }),
    LoggerModule,
    AiModule,
    ThreadModule,
    BenchmarkRunnerModule,
  ],
})
export class AppModule {}
