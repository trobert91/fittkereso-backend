import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './modules/app-config/app-config.module';
import { ConfigModule } from '@nestjs/config';
import { ConfigLoader } from './modules/app-config/loader/config-loader';
import { DatabaseModule } from '@fittkereso-backend/database';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostgresConfigService } from '@fittkereso-backend/config';
import { DataSourceOptions, DataSource } from 'typeorm';
import { WithLengthColumnType } from 'typeorm/driver/types/ColumnTypes';
import { HttpModule } from '@nestjs/axios';
import { AiModule } from '@fittkereso-backend/ai';
import { TaskModule } from '@fittkereso-backend/task';
import { DataforseoModule } from '@fittkereso-backend/dataforseo';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from '@fittkereso-backend/logger';
import { TestModule } from './modules/test/test.module';
import { QueueProcessorModule } from './modules/queue-processor/queue-processor.module';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { isSchedulerWorker } from '@fittkereso-backend/utils';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

const COLLECTOR_DEFAULT_POOL_SIZE = 50;

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
      name: 'postgres',
      useExisting: PostgresConfigService,
      dataSourceFactory: async (config: DataSourceOptions | undefined) => {
        if (!config) {
          throw new Error(
            'DataSourceOptions are required for postgres connection',
          );
        }
        // Concurrent imports hold a connection each for their product lock on
        // top of the ones they query with, so the collector's pool is sized
        // well above the driver's default of 10 unless postgres.pool_size
        // says otherwise.
        const dataSource = new DataSource({
          ...config,
          poolSize:
            (config as PostgresConnectionOptions).poolSize ??
            COLLECTOR_DEFAULT_POOL_SIZE,
        } as DataSourceOptions);

        // Add pgvector support
        dataSource.driver.supportedDataTypes.push(
          'vector' as WithLengthColumnType,
        );
        dataSource.driver.withLengthColumnTypes.push(
          'vector' as WithLengthColumnType,
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
