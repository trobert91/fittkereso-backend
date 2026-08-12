import { Module } from '@nestjs/common';
import { AppConfigModule } from './modules/app-config/app-config.module';
import { ConfigModule } from '@nestjs/config';
import { ConfigLoader } from './modules/app-config/loader/config-loader';
import { DatabaseModule } from '@fittkereso-backend/database';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostgresConfigService } from '@fittkereso-backend/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { WithLengthColumnType } from 'typeorm/driver/types/ColumnTypes';
import { LoggerModule } from '@fittkereso-backend/logger';
import { AiModule } from '@fittkereso-backend/ai';
import { McpModule, McpTransportType } from '@rekog/mcp-nest';
import { ToolsModule } from './modules/tools/tools.module';

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
        const dataSource = new DataSource(config);

        // Add pgvector support
        dataSource.driver.supportedDataTypes.push(
          'vector' as WithLengthColumnType,
        );
        dataSource.driver.withLengthColumnTypes.push(
          'vector' as WithLengthColumnType,
        );

        await dataSource.initialize();

        return dataSource;
      },
      inject: [PostgresConfigService],
    }),
    LoggerModule,
    AiModule,
    McpModule.forRoot({
      name: 'fittkereso',
      version: '1.0.0',
      transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
      logging: { level: ['log', 'warn', 'error'] },
    }),
    ToolsModule,
  ],
})
export class AppModule {}
