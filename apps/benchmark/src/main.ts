import fs from 'fs';
import path from 'path';
import * as jsYaml from 'js-yaml';
import { Logger } from '@nestjs/common';
import { validateConfigOrThrowError } from './modules/app-config/validator/config.validator';
import { createApp } from './app';
import { parseCliArgs, printUsage } from './cli';
import { BenchmarkRunner } from './modules/runner/benchmark-runner.service';

const yamlConfig = jsYaml.load(
  fs.readFileSync(path.join(__dirname, './config/config.yaml'), 'utf8'),
) as Record<string, any>;

validateConfigOrThrowError(yamlConfig);

async function bootstrap() {
  const logger = new Logger('benchmark');

  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const app = await createApp();

  try {
    const runner = app.get(BenchmarkRunner);
    const exitCode = await runner.run(args);
    await app.close();
    process.exit(exitCode);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    logger.error(`Benchmark run failed: ${message}`);
    await app.close();
    process.exit(1);
  }
}

bootstrap();
