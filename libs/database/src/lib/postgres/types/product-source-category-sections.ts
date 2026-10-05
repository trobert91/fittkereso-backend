import { cloneDeep, isEmpty } from 'lodash';
import { SourceSpecConfig } from './product-category-config';
import {
  CategoryMatchRule,
  ProductSourceCategoryConfig,
  ProductSourceConfig,
} from './product-source-config';
import { CategoryLookupRule } from './scrape-operation';

/** The part of a source config that holds its categories, whatever its type. */
type WithCategories = { categories?: Record<string, ProductSourceCategoryConfig> };

/** One category's section of a source config, or undefined when it has none. */
export function categorySectionOf(
  config: WithCategories | undefined,
  slug: string | undefined,
): ProductSourceCategoryConfig | undefined {
  return slug ? config?.categories?.[slug] : undefined;
}

/** Each category section's gate rules, in the config's order. */
export function categoryRulesOf(
  config: WithCategories | undefined,
): { slug: string; rules: CategoryMatchRule[] }[] {
  return Object.entries(config?.categories ?? {}).map(([slug, section]) => ({
    slug,
    rules: section.rules ?? [],
  }));
}

/** The slugs whose section is enabled. */
export function enabledCategorySlugs(config: WithCategories | undefined): string[] {
  return Object.entries(config?.categories ?? {})
    .filter(([, section]) => section.enabled)
    .map(([slug]) => slug);
}

/**
 * A config in the layout used before per-category sections. Typed loosely
 * because it is exactly the shape the current types no longer describe.
 */
interface LegacyConfig {
  categories?: Record<string, { enabled?: boolean; sourceTitle?: string } & Record<string, unknown>>;
  category?: { labelFrom?: unknown; slugLookup?: CategoryLookupRule[] } & Record<string, unknown>;
  specMapping?: Record<string, SourceSpecConfig>;
  identityExtraction?: { specRows?: string[] };
  detailPage?: {
    category?: { breadcrumbOrSource?: unknown; slugLookup?: CategoryLookupRule[] };
    specMapping?: Record<string, SourceSpecConfig>;
  } & Record<string, unknown>;
}

/** Whether a config still carries any key that per-category sections replaced. */
export function hasLegacyCategoryKeys(config: unknown, type: string): boolean {
  const legacy = (config ?? {}) as LegacyConfig;
  const sectionTitles = Object.values(legacy.categories ?? {}).some(
    (section) => section?.sourceTitle !== undefined,
  );
  if (legacy.identityExtraction !== undefined || sectionTitles) return true;
  return type === 'scraping'
    ? legacy.detailPage?.specMapping !== undefined || legacy.detailPage?.category?.slugLookup !== undefined
    : legacy.specMapping !== undefined || legacy.category?.slugLookup !== undefined;
}

/**
 * Moves everything about one category into `categories.<slug>`: its on/off
 * switch, its gate rules (in their order, without the slug), its spec
 * mapping and the identity spec rows. `sourceTitle`, which nothing read, is
 * dropped. A slug that only a rule or a mapping names gets a disabled
 * section, so nothing is lost.
 *
 * The one conversion for a stored config (the migration), a version restored
 * from before the change, and the fixtures. A config already in the new
 * layout comes back as an unchanged copy.
 */
export function toCategorySections(config: unknown, type: string): ProductSourceConfig {
  const copy = cloneDeep((config ?? {}) as LegacyConfig & Record<string, unknown>);
  if (!hasLegacyCategoryKeys(copy, type)) return copy as unknown as ProductSourceConfig;

  const sections: Record<string, ProductSourceCategoryConfig> = {};
  const sectionOf = (slug: string): ProductSourceCategoryConfig => (sections[slug] ??= { enabled: false });

  for (const [slug, old] of Object.entries(copy.categories ?? {})) {
    const { sourceTitle: _sourceTitle, ...rest } = old ?? {};
    sections[slug] = { ...(rest as unknown as ProductSourceCategoryConfig), enabled: old?.enabled ?? false };
  }

  const scraping = type === 'scraping';
  const rules = (scraping ? copy.detailPage?.category?.slugLookup : copy.category?.slugLookup) ?? [];
  for (const { slug, when, unless } of rules) {
    const section = sectionOf(slug);
    section.rules = [...(section.rules ?? []), unless ? { when, unless } : { when }];
  }

  const mappings = (scraping ? copy.detailPage?.specMapping : copy.specMapping) ?? {};
  for (const [slug, mapping] of Object.entries(mappings)) {
    sectionOf(slug).specMapping = mapping;
  }

  const specRows = copy.identityExtraction?.specRows;
  if (specRows?.length) {
    for (const section of Object.values(sections)) section.identitySpecRows = [...specRows];
  }

  delete copy.identityExtraction;
  if (scraping) {
    if (copy.detailPage) {
      delete copy.detailPage.specMapping;
      if (copy.detailPage.category) delete copy.detailPage.category.slugLookup;
    }
  } else {
    delete copy.specMapping;
    if (copy.category) {
      delete copy.category.slugLookup;
      if (isEmpty(copy.category)) delete copy.category;
    }
  }

  // Key order inside a section: switch, gate, mapping, identity rows.
  const ordered = Object.fromEntries(
    Object.entries(sections).map(([slug, section]) => {
      const { enabled, rules: sectionRules, specMapping, identitySpecRows, ...rest } = section;
      return [
        slug,
        {
          enabled,
          ...(sectionRules?.length ? { rules: sectionRules } : {}),
          ...(specMapping ? { specMapping } : {}),
          ...(identitySpecRows ? { identitySpecRows } : {}),
          ...rest,
        },
      ];
    }),
  );

  return { ...copy, categories: ordered } as unknown as ProductSourceConfig;
}
