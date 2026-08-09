import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import {
  BrandRepository,
  ProductCategoryRepository,
  ProductModel,
  ProductModelRepository,
} from "@ebike-backend/database";
import { generateSlug, nameOf } from "@ebike-backend/utils";

const BATCH_SIZE = 100;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const brandRepo = app.get(BrandRepository);
  const categoryRepo = app.get(ProductCategoryRepository);
  const productModelRepo = app.get(ProductModelRepository);

  // 1. Backfill Brand slugs
  console.log("Backfilling Brand slugs...");
  const brands = await brandRepo.getAll();
  const existingBrandSlugs = new Set<string>();

  for (let i = 0; i < brands.length; i += BATCH_SIZE) {
    const batch = brands.slice(i, i + BATCH_SIZE);
    for (const brand of batch) {
      if (brand.slug) {
        existingBrandSlugs.add(brand.slug);
        continue;
      }
      let slug = generateSlug(brand.id, brand.name);
      if (existingBrandSlugs.has(slug)) {
        slug = `${slug}-${brand.id.slice(-6)}`;
      }
      existingBrandSlugs.add(slug);
      brand.slug = slug;
    }
    await brandRepo.saveAll(batch);
  }
  console.log(`  Processed ${brands.length} brands.`);

  // 2. Backfill ProductCategory slugs
  console.log("Backfilling ProductCategory slugs...");
  const categories = await categoryRepo.getAll();
  const existingCategorySlugs = new Set<string>();

  for (let i = 0; i < categories.length; i += BATCH_SIZE) {
    const batch = categories.slice(i, i + BATCH_SIZE);
    for (const category of batch) {
      if (category.slug) {
        existingCategorySlugs.add(category.slug);
        continue;
      }
      let slug = generateSlug(category.id, category.name);
      if (existingCategorySlugs.has(slug)) {
        slug = `${slug}-${category.id.slice(-6)}`;
      }
      existingCategorySlugs.add(slug);
      category.slug = slug;
    }
    await categoryRepo.saveAll(batch);
  }
  console.log(`  Processed ${categories.length} categories.`);

  // 3. Backfill ProductModel slugs (LEFT JOIN brand)
  console.log("Backfilling ProductModel slugs...");
  const models = await productModelRepo.find({
    relations: [nameOf<ProductModel>("brand")],
  });
  const existingModelSlugs = new Set<string>();

  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    for (const model of batch) {
      if (model.slug) {
        existingModelSlugs.add(model.slug);
        continue;
      }
      const brandName = model.brand?.name ?? "";
      const modelName = model.model || model.displayName;
      let slug = generateSlug(model.id, brandName, modelName);
      if (existingModelSlugs.has(slug)) {
        slug = `${slug}-${model.id.slice(-6)}`;
      }
      existingModelSlugs.add(slug);
      model.slug = slug;
    }
    await productModelRepo.saveAll(batch);
  }
  console.log(`  Processed ${models.length} product models.`);

  console.log("Slug backfill complete.");
  await app.close();
}

bootstrap().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
