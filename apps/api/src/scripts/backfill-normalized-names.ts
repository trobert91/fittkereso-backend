import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { nameOf } from '@fittkereso-backend/utils';

const BATCH_SIZE = 100;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const productRepo = app.get(ProductModelRepository);
  const sourceRepo = app.get(ProductSourceRecordRepository);
  const normalizer = app.get(ProductNormalizerService);
  const categoryConfigService = app.get(CategoryConfigService);

  // 1. Backfill ProductModel.normalizedName
  console.log('Backfilling ProductModel.normalizedName...');
  const models = await productRepo.find({
    relations: [
      nameOf<ProductModel>('brand'),
      nameOf<ProductModel>('productCategory'),
    ],
  });

  let modelsUpdated = 0;
  let modelsSkipped = 0;
  let modelsFailed = 0;
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    const toSave: ProductModel[] = [];
    for (const model of batch) {
      const brandName = model.brand?.name ?? '';
      const strategy =
        categoryConfigService.getConfig(model.productCategory?.slug)
          ?.normalizationStrategy ?? 'digit-heuristic';
      try {
        const next = normalizer.normalizeProduct({
          brand: brandName,
          model: model.model,
          displayName: model.displayName,
          strategy,
        });
        if (!next || next === model.normalizedName) {
          modelsSkipped++;
          continue;
        }
        model.normalizedName = next;
        toSave.push(model);
      } catch (error) {
        modelsFailed++;
        console.warn(
          `  skip model ${model.id} (${model.displayName}): ${(error as Error).message}`,
        );
      }
    }

    for (const model of toSave) {
      try {
        await productRepo.save(model);
        modelsUpdated++;
      } catch (error) {
        modelsFailed++;
        console.warn(
          `  save failed model ${model.id} (${model.displayName}) → ${model.normalizedName}: ${(error as Error).message}`,
        );
      }
    }
    console.log(
      `  Processed ${Math.min(i + BATCH_SIZE, models.length)} / ${models.length}`,
    );
  }
  console.log(
    `  ProductModel: ${modelsUpdated} updated, ${modelsSkipped} unchanged, ${modelsFailed} failed.`,
  );

  // 2. Backfill ProductSourceRecord.normalizedSourceName
  console.log('Backfilling ProductSourceRecord.normalizedSourceName...');
  const sources = await sourceRepo.find({
    relations: [
      nameOf<ProductSourceRecord>('model'),
      `${nameOf<ProductSourceRecord>('model')}.${nameOf<ProductModel>('brand')}`,
      `${nameOf<ProductSourceRecord>('model')}.${nameOf<ProductModel>('productCategory')}`,
    ],
  });

  let sourcesUpdated = 0;
  let sourcesSkipped = 0;
  let sourcesFailed = 0;
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    const toSave: ProductSourceRecord[] = [];
    for (const source of batch) {
      const brandName = source.model?.brand?.name ?? '';
      const displayName = source.sourceName ?? source.model?.displayName;
      if (!displayName) {
        sourcesSkipped++;
        continue;
      }
      const strategy =
        categoryConfigService.getConfig(source.model?.productCategory?.slug)
          ?.normalizationStrategy ?? 'digit-heuristic';
      try {
        const next = normalizer.normalizeProduct({
          brand: brandName,
          model: undefined,
          displayName,
          strategy,
        });
        if (!next || next === source.normalizedSourceName) {
          sourcesSkipped++;
          continue;
        }
        source.normalizedSourceName = next;
        toSave.push(source);
      } catch (error) {
        sourcesFailed++;
        console.warn(
          `  skip source ${source.id} (${displayName}): ${(error as Error).message}`,
        );
      }
    }

    for (const source of toSave) {
      try {
        await sourceRepo.save(source);
        sourcesUpdated++;
      } catch (error) {
        sourcesFailed++;
        console.warn(
          `  save failed source ${source.id} → ${source.normalizedSourceName}: ${(error as Error).message}`,
        );
      }
    }
    console.log(
      `  Processed ${Math.min(i + BATCH_SIZE, sources.length)} / ${sources.length}`,
    );
  }
  console.log(
    `  ProductSourceRecord: ${sourcesUpdated} updated, ${sourcesSkipped} unchanged, ${sourcesFailed} failed.`,
  );

  console.log('Normalized-name backfill complete.');
  await app.close();
}

bootstrap().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
