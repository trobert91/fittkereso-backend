import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProductCategory, ProductCategoryRepository } from '@fittkereso-backend/database';
import { generateSlug } from '@fittkereso-backend/utils';

// Creates one product category by name, e.g. "Bikes". Its slug must equal its
// spec-definition directory, libs/config/src/lib/categories/<slug>/, which
// generateSlug gives for a plain name ("Bikes" → "bikes").
// Usage: API_CONFIG_PATH=apps/api/src/config/config.yaml npx ts-node --project apps/api/tsconfig.app.json -r tsconfig-paths/register apps/api/src/scripts/create-category.ts <name>
// Mirrors CategoryTools.createCategory in apps/mcp/src/modules/tools/category/category.tools.ts
async function bootstrap(name: string | undefined) {
  if (!name) throw new Error('Usage: create-category.ts <name>');
  const app = await NestFactory.createApplicationContext(AppModule);

  const categoryRepo = app.get(ProductCategoryRepository);

  const existing = await categoryRepo.findByName(name);
  if (existing) {
    console.log(`Category "${name}" already exists (${existing.id}, slug: ${existing.slug}). Skipping.`);
    await app.close();
    return;
  }

  const category = new ProductCategory();
  category.name = name;
  category.enabled = true;

  let slug = generateSlug(randomUUID(), name);
  const slugCollision = await categoryRepo.findOne({
    where: { slug },
    select: ['id'],
  });
  if (slugCollision) {
    slug = `${slug}-${randomUUID().slice(-6)}`;
  }
  category.slug = slug;

  const saved = await categoryRepo.save(category);

  console.log(`Created ProductCategory "${saved.name}" (slug: ${saved.slug}, id: ${saved.id}).`);
  console.log(`Add config at libs/config/src/lib/categories/${saved.slug}/config.json.`);

  await app.close();
}

bootstrap(process.argv[2]).catch((err) => {
  console.error('Failed to create the category:', err);
  process.exit(1);
});
