import { readFileSync } from 'fs';
import { join } from 'path';

/** One list card of `props.products`, as ebikeshop serves it. */
export interface EbikeshopCardJson {
  productName: string;
  productCode: string;
  showPageUrl: string;
  isUsed: boolean;
  preorderTypeTitle: string | null;
  prices: { price: number; priceSale: number; sale: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** `props.product` of a product page, as ebikeshop serves it. */
export interface EbikeshopProductJson {
  name: string;
  productCode: string;
  gtin: string;
  manufacturer: { title: string; [key: string]: unknown } | null;
  legalManufacturerName: string | null;
  prices: { price: number; priceSale: number; sale: boolean; [key: string]: unknown };
  variations: Array<{
    type: string;
    items: Array<{ productCode: string; gtin: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  properties: Array<{ categoryTitle: string; value: string; quantityUnit: string; [key: string]: unknown }>;
  locations: string[];
  /** HTML: a per-brand "A gyártóról" blurb, the bike's own blocks, a closing "Általános" block. */
  longDesc: string;
  category: { name: string; slug: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** The Inertia page object ebikeshop embeds in `<div id="app" data-page="…">`. */
export interface EbikeshopDataPage {
  component: string;
  /** The path actually served, which differs from the requested one after a redirect. */
  url: string;
  props: {
    meta?: { h1Title: string | null };
    /** An array, or an object keyed "0"…"n" when Laravel serializes it so. */
    products?: EbikeshopCardJson[] | Record<string, EbikeshopCardJson>;
    product?: EbikeshopProductJson;
    [key: string]: unknown;
  };
}

/** A real ebikeshop.hu page, trimmed to what the ebikeshop config reads. See README.md. */
export interface EbikeshopCapture {
  requestedUrl: string;
  capturedAt: string;
  via: string;
  note: string;
  dataPage: EbikeshopDataPage;
  /** The page's `<script type="application/ld+json">` body, where it has one. */
  jsonLd?: string;
  /** The page's "Üzletek" (stores) section, where it has one. */
  storesHtml?: string;
}

export type EbikeshopCaptureName =
  | 'list-page-7'
  | 'list-page-14'
  | 'list-all-page-30-object-shaped'
  | 'detail-ktm-exonicx-48'
  | 'detail-rm-delite4-speed'
  | 'detail-rm-homage5-extrak'
  | 'detail-ktm-chacana-791'
  | 'detail-cube-supreme-varhato'
  | 'unknown-slug-fuzzy-redirect'
  | 'unknown-slug-home-redirect';

/** A fresh copy each call, so a spec can change it without affecting the next. */
export function loadEbikeshopCapture(name: EbikeshopCaptureName): EbikeshopCapture {
  return JSON.parse(readFileSync(join(__dirname, `${name}.json`), 'utf8'));
}

/**
 * The capture as page HTML, in the three places the config reads: the
 * `data-page` attribute (entity-escaped as a browser would receive it), the
 * JSON-LD script, and the "Üzletek" section.
 */
export function ebikeshopPageHtml(capture: EbikeshopCapture): string {
  const dataPage = JSON.stringify(capture.dataPage)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  const jsonLd = capture.jsonLd
    ? `<script type="application/ld+json">${capture.jsonLd}</script>`
    : '';
  return `<div id="app" data-page="${dataPage}"></div>${jsonLd}${capture.storesHtml ?? ''}`;
}

/** The capture's list cards, whichever shape the page used. */
export function ebikeshopCards(capture: EbikeshopCapture): EbikeshopCardJson[] {
  const products = capture.dataPage.props.products ?? [];
  return Array.isArray(products) ? products : Object.values(products);
}
