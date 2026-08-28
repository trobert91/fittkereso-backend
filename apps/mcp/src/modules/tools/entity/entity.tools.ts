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
      'Get detailed product information — display name, brand, model, specs, aliases, category, plus every ProductSourceRecord (one per scraped URL, with its own externalId/offerSpecsHash/productSpecsHash/spec validity) and every Offer (price, availability, seller, externalId, and which source record it belongs to). Use to investigate product resolution accuracy, verify if the correct product was matched, or debug why a scrape did or did not produce a new/updated offer.',
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
      relations: [
        'brand',
        'productCategory',
        'aliases',
        'sources',
        'sources.source',
        'sources.offers',
        'sources.offers.seller',
        'offers',
        'offers.seller',
        'offers.sourceRecord',
      ],
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

    // Product Source Records
    const sources = product.sources ?? [];
    if (sources.length > 0) {
      L.push(`## Product Source Records (${sources.length})`);
      for (const record of sources) {
        L.push(`### ${record.source?.name ?? '(no source)'} — ${record.url ?? '(no url)'}`);
        L.push(`- **ID**: ${record.id}`);
        if (record.externalId) L.push(`- **External ID**: ${record.externalId}`);
        L.push(`- **Last Updated**: ${record.lastUpdated?.toISOString?.() ?? record.lastUpdated}`);
        L.push(`- **Offer Specs Hash**: ${record.offerSpecsHash ?? '(none)'}`);
        L.push(`- **Product Specs Hash**: ${record.productSpecsHash ?? '(none)'}`);
        L.push(`- **Spec Valid**: ${record.specValid}`);
        if (record.specErrors && Object.keys(record.specErrors).length > 0) {
          L.push(`- **Spec Errors**: ${JSON.stringify(record.specErrors)}`);
        }
        if (record.normalizedSourceName)
          L.push(`- **Normalized Source Name**: ${record.normalizedSourceName}`);

        const recordOffers = record.offers ?? [];
        if (recordOffers.length > 0) {
          L.push(`- **Offers on this record (${recordOffers.length})**:`);
          for (const offer of recordOffers) {
            const locationsSuffix =
              offer.locations && offer.locations.length > 0
                ? ` · locations=${offer.locations.join(', ')}`
                : '';
            L.push(
              `  - ${offer.seller?.name ?? '?'} · ${offer.price} ${offer.currency} · ${offer.availability} · externalId=${offer.externalId ?? '(none)'} · active=${offer.active}${locationsSuffix}`,
            );
          }
        } else {
          L.push(`- **Offers on this record**: none`);
        }
        L.push('');
      }
    }

    // Offers (model-level, all sources combined)
    const offers = product.offers ?? [];
    if (offers.length > 0) {
      L.push(`## Offers (${offers.length})`);
      for (const offer of offers) {
        L.push(`### ${offer.seller?.name ?? '(no seller)'} — ${offer.price} ${offer.currency}`);
        L.push(`- **ID**: ${offer.id}`);
        L.push(`- **Availability**: ${offer.availability}`);
        L.push(`- **Condition**: ${offer.condition}`);
        L.push(`- **URL**: ${offer.url ?? '(none)'}`);
        L.push(`- **External ID**: ${offer.externalId ?? '(none)'}`);
        L.push(
          `- **Source Record**: ${offer.sourceRecord?.url ?? offer.sourceRecord?.id ?? '(none)'}`,
        );
        L.push(`- **Active**: ${offer.active}`);
        L.push(`- **Last Seen At**: ${offer.lastSeenAt?.toISOString?.() ?? offer.lastSeenAt}`);
        if (offer.locations && offer.locations.length > 0) {
          L.push(`- **Locations**: ${offer.locations.join(', ')}`);
        }
        if (offer.specs && Object.keys(offer.specs).length > 0) {
          L.push(`- **Offer Specs**: ${JSON.stringify(offer.specs)}`);
        }
        L.push('');
      }
    }

    return L.join('\n');
  }
}
