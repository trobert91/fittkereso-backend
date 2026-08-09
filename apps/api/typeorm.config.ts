import { DataSource } from 'typeorm';
import fs from 'fs';
import path, { join } from 'path';
import jsYaml from 'js-yaml';

const YAML_CONFIG_FILENAME = './src/config/config.yaml';
const yamlConfig = jsYaml.load(
  fs.readFileSync(path.join(__dirname, YAML_CONFIG_FILENAME), 'utf8'),
) as Record<string, any>;

const migrationDataSource = new DataSource({
  type: 'postgres',
  host: yamlConfig.postgres.host,
  port: parseInt(yamlConfig.postgres.port!),
  username: yamlConfig.postgres.user,
  password: yamlConfig.postgres.password,
  database: yamlConfig.postgres.database,
  entities: [join(__dirname, '../../libs/database/src/lib/postgres/models/*.entity{.ts,.js}')],
  migrations: [join(__dirname, '../../libs/config/src/lib/migrations/*{.ts,.js}')],
  migrationsRun: true,
  migrationsTableName: 'migrations',
});

export default migrationDataSource;
