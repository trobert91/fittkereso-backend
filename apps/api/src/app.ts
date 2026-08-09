import { NestFactory, Reflector } from "@nestjs/core";
import {
  ClassSerializerInterceptor,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from "@nestjs/common";
import { AppConfigService } from "./modules/app-config/services/app-config.service";
import { LoggerService } from "@ebike-backend/logger";
import { AppModule } from "./app.module";
import { SerializeGroup } from "@ebike-backend/utils";
import cookieParser from "cookie-parser";

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
  expressApp.set("query parser", "extended");

  app.setGlobalPrefix("api", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "metrics", method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector), {
      strategy: "excludeAll",
      groups: [SerializeGroup.list],
    }),
  );
  app.use(cookieParser());

  const appConfig: AppConfigService = app.get(AppConfigService);

  const allowedOrigins = ["https://ebike.com", "https://app.ebike.com"];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }
  if (appConfig.environment === "dev") {
    allowedOrigins.push("http://localhost:3200");
    allowedOrigins.push("http://localhost:3201");
    allowedOrigins.push("http://localhost:3000");
  }

  app.enableCors({
    origin: allowedOrigins,
    allowedHeaders:
      "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Observe, Authorization, OrganizationId, ProjectId",
    methods: "GET,PUT,POST,DELETE,UPDATE,OPTIONS",
    credentials: true,
  });
};
