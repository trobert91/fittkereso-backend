import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { AppConfigService } from './modules/app-config/services/app-config.service';
import { LoggerService } from '@fittkereso-backend/logger';

export const createApp = async (): Promise<INestApplication> => {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(LoggerService);
  app.useLogger(logger);
  configureApp(app);
  await app.init();

  return app;
};

const configureApp = (app: INestApplication) => {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  const appConfig: AppConfigService = app.get(AppConfigService);

  const allowedOrigins = [
    'https://fittkereso.com',
    'https://app.fittkereso.com',
  ];
  if (appConfig.environment === 'dev') {
    allowedOrigins.push('http://localhost:3200');
  }

  app.enableCors({
    origin: allowedOrigins,
    allowedHeaders:
      'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Observe, Authorization, OrganizationId, ProjectId',
    methods: 'GET,PUT,POST,DELETE,UPDATE,OPTIONS',
    credentials: true,
  });
};
