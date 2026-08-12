import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { validateConfigOrThrowError } from './modules/app-config/validator/config.validator';
import { AppConfigService } from './modules/app-config/services/app-config.service';
import { INestApplication, Logger } from '@nestjs/common';
import * as jsYaml from 'js-yaml';
import { PostgresConfigService } from '@fittkereso-backend/config';
import { DataSource, DataSourceOptions } from 'typeorm';

const yamlConfig = jsYaml.load(
  fs.readFileSync(path.join(__dirname, './config/config.yaml'), 'utf8'),
) as Record<string, any>;

async function runApp() {
  const logger = new Logger();

  const app = await createApp();
  const configService: AppConfigService = app.get(AppConfigService);

  await runMigrationsIfEnabled(app);

  await app.listen(configService.httpPort);
  logger.log('App listening on port ' + configService.httpPort);
}

async function runMigrationsIfEnabled(app: INestApplication) {
  const postgres = app.get(PostgresConfigService);
  if (!postgres.migrationsEnabled) {
    return;
  }

  console.log('Running migrations...');

  const dataSource = new DataSource({
    ...(postgres.createTypeOrmOptions() as DataSourceOptions),
    logging: ['migration'],
  });

  await dataSource.initialize();
  // Specify which migrations to run
  await dataSource.runMigrations({
    transaction: 'each', // 'all', 'each', or 'none'
  });
  await dataSource.destroy();

  console.log('Migrations completed, datasource destroyed.');
}

validateConfigOrThrowError(yamlConfig);

runApp();
