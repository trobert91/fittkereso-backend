import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AppConfigModule } from "./modules/app-config/app-config.module";
import { ConfigModule } from "@nestjs/config";
import { ConfigLoader } from "./modules/app-config/loader/config-loader";
import { DatabaseModule } from "@ebike-backend/database";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PostgresConfigService } from "@ebike-backend/config";
import { DataSourceOptions, DataSource } from "typeorm";
import { WithLengthColumnType } from "typeorm/driver/types/ColumnTypes";
import { HttpModule } from "@nestjs/axios";
import { AiModule } from "@ebike-backend/ai";
import { TaskModule } from "@ebike-backend/task";
import { DataforseoModule } from "@ebike-backend/dataforseo";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "@ebike-backend/logger";
import { TestModule } from "./modules/test/test.module";
import { QueueProcessorModule } from "./modules/queue-processor/queue-processor.module";
import { MetricsModule } from "@ebike-backend/metrics";
import { SchedulingModule } from "./modules/scheduling/scheduling.module";
import { isSchedulerWorker } from "@ebike-backend/utils";

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
    AiModule,
    TaskModule,
    DataforseoModule,
    ScheduleModule.forRoot(),
    LoggerModule,
    TestModule,
    QueueProcessorModule,
    MetricsModule,
    ...(isSchedulerWorker() ? [SchedulingModule] : []),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
