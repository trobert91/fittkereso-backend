import { Module } from '@nestjs/common';
import { LoggerModule } from '@fittkereso-backend/logger';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './modules/app-config/app-config.module';
import { ConfigModule } from '@nestjs/config';
import { ConfigLoader } from './modules/app-config/loader/config-loader';
import { DatabaseModule } from '@fittkereso-backend/database';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { PostgresConfigService } from '@fittkereso-backend/config';
import { DataSourceOptions, DataSource } from 'typeorm';
import { WithLengthColumnType } from 'typeorm/driver/types/ColumnTypes';
import { ApiAuthModule } from './modules/api-auth/api-auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EntityNotFoundExceptionFilter } from './exceptions/entity-not-found';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ThrottlerModule } from '@nestjs/throttler';
import { PublicModule } from './modules/public/public.module';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { AuthGuard, AuthModule, RoleGuard } from '@fittkereso-backend/auth';

@Module({
  imports: [
    AppConfigModule,
    ApiAuthModule,
    AuthModule,
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
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino/file', options: { destination: 1 } }
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
      { name: 'autocomplete', ttl: 60_000, limit: 300 },
      { name: 'contact', ttl: 600_000, limit: 3 },
      { name: 'feedback', ttl: 3_600_000, limit: 5 },
    ]),
    AdminModule,
    MetricsModule,
    ProductIdentityModule,
    PublicModule,
  ],
  providers: [
    // Authentication is on by default for the whole HTTP surface; routes opt
    // out with @Public(). Order matters - AuthGuard resolves the caller and
    // RoleGuard then reads what it attached.
    //
    // API-only. apps/mcp and apps/product-collector import neither AuthModule
    // nor AdminModule, register no APP_GUARD, and reach Postgres directly
    // rather than over this HTTP surface, so they are unaffected.
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RoleGuard,
    },
    {
      provide: APP_FILTER,
      useClass: EntityNotFoundExceptionFilter,
    },
  ],
})
export class AppModule {}
