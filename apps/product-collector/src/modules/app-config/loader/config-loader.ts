import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';

const YAML_CONFIG_FILENAME = './config/config.yaml';

// The built app reads the config webpack copies next to main.js. A script run
// from source (ts-node) has no such copy, so PRODUCT_COLLECTOR_CONFIG_PATH
// points it at the checked-in file instead — see the scripts in ../../scripts.
export const ConfigLoader = () => {
  const configPath =
    process.env.PRODUCT_COLLECTOR_CONFIG_PATH ??
    join(__dirname, YAML_CONFIG_FILENAME);
  return yaml.load(readFileSync(configPath, 'utf8')) as Record<string, any>;
};
