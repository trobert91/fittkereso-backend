import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';

const YAML_CONFIG_FILENAME = './config/config.yaml';

/**
 * The built app reads the config webpack copied next to main.js. Scripts run
 * from source with ts-node (`apps/api/src/scripts/**`) have no such copy, so
 * they point `API_CONFIG_PATH` at `apps/api/src/config/config.yaml` instead.
 */
export const ConfigLoader = () => {
  const configPath =
    process.env.API_CONFIG_PATH ?? join(__dirname, YAML_CONFIG_FILENAME);
  return yaml.load(readFileSync(configPath, 'utf8')) as Record<string, any>;
};
