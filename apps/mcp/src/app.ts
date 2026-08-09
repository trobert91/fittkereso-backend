import { NestFactory } from "@nestjs/core";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "./app.module";
import { LoggerService } from "@ebike-backend/logger";

export const createApp = async (): Promise<INestApplication> => {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(LoggerService);
  app.useLogger(logger);

  return app;
};
