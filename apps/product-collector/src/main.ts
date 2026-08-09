import fs from 'fs';
import path from 'path';
import * as jsYaml from 'js-yaml';

const yamlConfig = jsYaml.load(
  fs.readFileSync(path.join(__dirname, './config/config.yaml'), 'utf8'),
) as Record<string, any>;

// Only set SERVICE_TYPE from config if not already defined in environment
if (!process.env['SERVICE_TYPE']) {
  process.env['SERVICE_TYPE'] = yamlConfig.service_type;
}

import { createApp } from './app';
import { validateConfigOrThrowError } from './modules/app-config/validator/config.validator';
import { AppConfigService } from './modules/app-config/services/app-config.service';
import { Logger } from '@nestjs/common';
async function runApp() {
  const logger = new Logger();

  const app = await createApp();
  const configService: AppConfigService = app.get(AppConfigService);

  if (process.env['SERVICE_TYPE'] === 'worker') {
    logger.log('Worker started without exposed API, except health endpoint.');
  } else if (process.env['SERVICE_TYPE'] === 'scheduler-worker') {
    logger.log(
      'Scheduler worker started without exposed API, except health endpoint.',
    );
  }

  await app.listen(configService.httpPort);
  logger.log('App listening on port ' + configService.httpPort);
}

validateConfigOrThrowError(yamlConfig);

runApp();
