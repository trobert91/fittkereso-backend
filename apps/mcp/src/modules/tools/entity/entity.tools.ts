import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ProductModelRepository } from '@fittkereso-backend/database';

@Injectable()
export class EntityTools {
  constructor(private readonly productRepo: ProductModelRepository) {}

  @Tool({
    name: 'get_product_detail',
    description:
      'Get detailed product information — display name, brand, model, specs, aliases, category. Use to investigate product resolution accuracy and verify if the correct product was matched.',
    parameters: z.object({
      productId: z.string().optional().describe('Product model UUID'),
      slug: z
        .string()
        .optional()
        .describe('Product slug (alternative to productId)'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductDetail(args: {
    productId?: string;
    slug?: string;
  }): Promise<string> {
    if (!args.productId && !args.slug) {
      return 'Error: provide either productId or slug';
    }

    const where = args.productId ? { id: args.productId } : { slug: args.slug };

    const product = await this.productRepo.findOneOrFail({
      where,
      relations: ['brand', 'productCategory', 'aliases'],
    });

    const L: string[] = [];

    // Header
    L.push(`# Product Detail`);
    L.push(`- **ID**: ${product.id}`);
    L.push(`- **Display Name**: ${product.displayName}`);
    L.push(`- **Model**: ${product.model}`);
    L.push(
      `- **Normalized Name**: ${product.brand?.name ?? '?'} / ${product.normalizedName}`,
    );
    L.push(`- **Enabled**: ${product.enabled}`);
    if (product.slug) L.push(`- **Slug**: ${product.slug}`);
    if (product.releaseYear)
      L.push(`- **Release Year**: ${product.releaseYear}`);
    L.push('');

    // Brand
    if (product.brand) {
      L.push('## Brand');
      L.push(`- **Name**: ${product.brand.name}`);
      L.push(`- **ID**: ${product.brand.id}`);
      L.push('');
    }

    // Category
    if (product.productCategory) {
      L.push('## Category');
      L.push(`- **Name**: ${product.productCategory.name}`);
      L.push('');
    }

    // Specs
    if (product.specs && Object.keys(product.specs).length > 0) {
      L.push('## Specs');
      for (const [key, value] of Object.entries(product.specs)) {
        L.push(`- **${key}**: ${value}`);
      }
      L.push('');
    }

    // Aliases
    const aliases = product.aliases ?? [];
    if (aliases.length > 0) {
      L.push(`## Aliases (${aliases.length})`);
      for (const alias of aliases) {
        L.push(`- ${alias.alias}`);
      }
      L.push('');
    }

    // Description
    if (product.description) {
      L.push('## Description');
      L.push(product.description);
      L.push('');
    }

    return L.join('\n');
  }
}
