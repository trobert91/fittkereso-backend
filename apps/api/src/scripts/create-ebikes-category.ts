import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProductCategory, ProductCategoryRepository } from '@fittkereso-backend/database';
import { generateSlug } from '@fittkereso-backend/utils';

const NAME = 'Ebikes';

// Mirrors CategoryTools.createCategory in apps/mcp/src/modules/tools/category/category.tools.ts
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const categoryRepo = app.get(ProductCategoryRepository);

  const existing = await categoryRepo.findByName(NAME);
  if (existing) {
    console.log(`Category "${NAME}" already exists (${existing.id}, slug: ${existing.slug}). Skipping.`);
    await app.close();
    return;
  }

  const category = new ProductCategory();
  category.name = NAME;
  category.enabled = true;

  let slug = generateSlug(randomUUID(), NAME);
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

bootstrap().catch((err) => {
  console.error('Failed to create ebikes category:', err);
  process.exit(1);
});
