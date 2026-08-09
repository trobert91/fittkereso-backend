import { NestFactory } from "@nestjs/core";
import { INestApplicationContext } from "@nestjs/common";
import { AppModule } from "./app.module";
import { LoggerService } from "@ebike-backend/logger";

export const createApp = async (): Promise<INestApplicationContext> => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(LoggerService);
  app.useLogger(logger);

  return app;
};
