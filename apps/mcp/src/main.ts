import fs from 'fs';
import path from 'path';
import * as jsYaml from 'js-yaml';
import { Logger } from '@nestjs/common';
import { validateConfigOrThrowError } from './modules/app-config/validator/config.validator';
import { createApp } from './app';

const yamlConfig = jsYaml.load(
  fs.readFileSync(path.join(__dirname, './config/config.yaml'), 'utf8'),
) as Record<string, any>;

validateConfigOrThrowError(yamlConfig);

async function bootstrap() {
  const logger = new Logger();
  const app = await createApp();

  const port = yamlConfig['port'] ?? 8090;
  await app.listen(port);
  logger.log(`MCP server listening on port ${port}`);

  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
}

bootstrap();
