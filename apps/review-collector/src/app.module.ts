import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AppConfigModule } from "./modules/app-config/app-config.module";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TestModule } from "./modules/test/test.module";
import { SchedulingModule } from "./modules/scheduling/scheduling.module";
import { QueueProcessorModule } from "./modules/queue-processor/queue-processor.module";
import { HttpModule } from "@nestjs/axios";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminModule } from "./modules/admin/admin.module";
import { DataSource, DataSourceOptions } from "typeorm";
import { WithLengthColumnType } from "typeorm/driver/types/ColumnTypes.js";
import { ThreadProcessorModule } from "./modules/thread-processor/thread-processor.module";
import { PostgresConfigService } from "@ebike-backend/config";
import { DatabaseModule } from "@ebike-backend/database";
import { DataforseoModule } from "@ebike-backend/dataforseo";
import { LoggerModule } from "@ebike-backend/logger";
import { TaskModule } from "@ebike-backend/task";
import { isSchedulerWorker, isWorker } from "@ebike-backend/utils";
import { AiModule } from "@ebike-backend/ai";
import { ConfigLoader } from "./modules/app-config/loader/config-loader";
import { MetricsModule } from "@ebike-backend/metrics";
import { ReviewCreatorModule } from "./modules/review-creator/review-creator.module";

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
    TestModule,
    AiModule,
    TaskModule,
    ...(isSchedulerWorker() ? [SchedulingModule] : []),
    ...(isSchedulerWorker() || isWorker() ? [QueueProcessorModule] : []),
    DataforseoModule,
    ScheduleModule.forRoot(),
    AdminModule,
    LoggerModule,
    ThreadProcessorModule,
    MetricsModule,
    ReviewCreatorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
