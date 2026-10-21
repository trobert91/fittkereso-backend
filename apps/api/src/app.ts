import { NestFactory, Reflector } from '@nestjs/core';
import {
  ClassSerializerInterceptor,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { AppConfigService } from './modules/app-config/services/app-config.service';
import { LoggerService } from '@fittkereso-backend/logger';
import { AppModule } from './app.module';
import { SerializeGroup } from '@fittkereso-backend/utils';
import cookieParser from 'cookie-parser';

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
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('query parser', 'extended');

  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector), {
      strategy: 'excludeAll',
      groups: [SerializeGroup.list],
    }),
  );
  app.use(cookieParser());

  const appConfig: AppConfigService = app.get(AppConfigService);

  const allowedOrigins = [
    'https://fittkereso.com',
    'https://app.fittkereso.com',
    // The public website: its contact form posts to /api/v1/public/contact.
    'https://fittkereso.hu',
    'https://www.fittkereso.hu',
  ];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }
  if (appConfig.environment === 'dev') {
    allowedOrigins.push('http://localhost:3200');
    allowedOrigins.push('http://localhost:3201');
    allowedOrigins.push('http://localhost:3000');
    allowedOrigins.push('http://localhost:3300');
  }

  app.enableCors({
    origin: allowedOrigins,
    allowedHeaders:
      'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Observe, Authorization, OrganizationId, ProjectId',
    // PATCH has to be listed: it is not a CORS-safelisted method, so without
    // it the browser's preflight refuses PATCH /admin-user/:id and /auth/me.
    methods: 'GET,PUT,POST,PATCH,DELETE,UPDATE,OPTIONS',
    credentials: true,
  });
};
