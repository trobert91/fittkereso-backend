/**
 * Sets a ProductSource's import frequency and scheduling flag.
 *
 * Goes through ProductSourceUpdateService rather than touching the columns, so
 * the change lands on the source's own timeline as a `scheduling_changed`
 * action like any other edit.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/set-source-frequency.ts <name> <frequency|null> [scheduling:on|off]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  ProductSourceRepository,
  systemActor,
} from '@fittkereso-backend/database';
import { ProductSourceUpdateService } from '@fittkereso-backend/product';

async function main(): Promise<void> {
  const [name, frequencyArg, schedulingArg] = process.argv.slice(2);

  if (!name || !frequencyArg) {
    console.error(
      'Usage: set-source-frequency.ts <name> <frequency|null> [scheduling:on|off]',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const sourceRepo = app.get(ProductSourceRepository);
    const updateService = app.get(ProductSourceUpdateService);

    const source = await sourceRepo.findOne({ where: { name } });
    if (!source) {
      console.error(`No product source named "${name}"`);
      process.exit(1);
    }

    const params: Record<string, unknown> = {
      frequency: frequencyArg === 'null' ? null : frequencyArg,
      actor: systemActor('script'),
    };

    if (schedulingArg === 'on') params['schedulingEnabled'] = true;
    if (schedulingArg === 'off') params['schedulingEnabled'] = false;

    const updated = await updateService.updateProductSource(
      source.id,
      params as never,
    );

    console.log(
      `${updated.name} (${updated.id}): type=${updated.type} ` +
        `frequency=${updated.frequency ?? 'null'} ` +
        `schedulingEnabled=${updated.schedulingEnabled} ` +
        `processingEnabled=${updated.processingEnabled} ` +
        `nextRunAt=${updated.nextRunAt?.toISOString() ?? 'null (due on next tick)'}`,
    );
  } finally {
    await app.close();
  }

  // The Nest context keeps handles open, so without this the script hangs.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
