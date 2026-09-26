# ebikeshop.hu captures

Real pages of ebikeshop.hu, used as the golden inputs of `../ebikeshop-list-page.spec.ts` and
`../ebikeshop-detail-page.spec.ts`. Captured on 2026-09-26 through Zyte, with the MCP tool
`fetch_website_html`: the same path the `ebikeshop` scraping source fetches with.

ebikeshop is an Inertia (Laravel + Vue) app. Every page embeds its whole state as JSON in
`<div id="app" data-page="…">`, and that is what the config reads. Each file here keeps:

- `requestedUrl`: what was fetched;
- `dataPage`: the `data-page` object, trimmed to what the config reads. `url` is the path actually
  served, which differs from `requestedUrl` after a redirect;
- `jsonLd`: the page's `<script type="application/ld+json">` body, where it has one. The detail
  offer reads its availability from it;
- `storesHtml`: the page's "Üzletek" (stores) section, where it has one. The config no longer reads
  it (the stores come from `props.product.locations`); it is kept to show what the page displays.

`ebikeshop-captures.ts` loads a file and rebuilds the HTML the config sees (`ebikeshopPageHtml`).

## The files

| File | Requested | Why it is here |
|---|---|---|
| `list-page-7.json` | `/termekek/elektromos-kerekparok?oldal=7` | Cards in every stock title but one, including the only "Gyártói tervezet" card, on and off sale. Trimmed from 32 cards to 5. |
| `list-page-14.json` | `/termekek/elektromos-kerekparok?oldal=14` | A "Várható gyártás" card, plus one card on sale and one not. Trimmed from 32 to 3. |
| `list-all-page-30-object-shaped.json` | `/termekek?oldal=30` | The whole shop's page 30, where Laravel serialized `props.products` as an **object** keyed `"0"`…`"30"`, not an array. Trimmed from 31 entries to 4, keeping their keys. |
| `detail-ktm-exonicx-48.json` | KTM MACINA SCARP SX EXONICX T-TYPE 48cm '26 | Three frame sizes, with a GTIN on this size only. Manufacturer stock (JSON-LD PreOrder). Not on sale. The stores list holds only "Gyártói készlet". |
| `detail-rm-delite4-speed.json` | RM Delite4 GT vario HS HE51 cm | 45 km/h (S-Pedelec), Enviolo hub gear, `27,5` wheels. On sale. In stock in one store. No variations, no GTIN. |
| `detail-rm-homage5-extrak.json` | RM Homage5 GT rohloff US56 cm (Extrák: …) | A name with an "(Extrák: …)" suffix. On sale. In stock in one store. No variations, no GTIN. |
| `detail-ktm-chacana-791.json` | KTM MACINA CHACANA 791 43 cm | A `longDesc` that is only the per-brand "A gyártóról" blurb (447 characters). On sale. In stock in one store. |
| `detail-cube-supreme-varhato.json` | CUBE Supreme Hybrid deluxe Pro 600 US46cm '26 | "Várható gyártás": stock type `preorder`, and JSON-LD PreOrder with `availabilityStarts`. Its stores section shows the expected production date, not a store. |
| `unknown-slug-fuzzy-redirect.json` | `/termek/fittkereso-nem-letezo-termek` | **An unknown product slug.** ebikeshop 301-redirects it to a fuzzy-matched, *unrelated* product: here a Powunity cable (`dataPage.url` is its path). |
| `unknown-slug-home-redirect.json` | `/termek/qxzvw-jkqyp-zzzz` | An unknown slug with no plausible match. ebikeshop redirects it to the home page (`home/Home`): there is no `props.product`. |

## What the captures showed

- **ebikeshop never answers a product URL with a 404.**
  - An unknown slug redirects to another product, or to the home page. Both slugs tried that
    contain "nem" landed on "Powunity Biketrax kábel (Gen4 nem smart)", so the match looks fuzzy on
    the slug's words.
  - Zyte follows the redirect. So a delisted product's URL can come back as a different product's
    page, and only `dataPage.url` and the product's `productCode` tell them apart.
- **Names carry plain apostrophes** (`'26`). The HTML entities (`&#39;26`) that earlier synthetic
  inputs used no longer appear.
- **`priceSale` is `0` on every card not on sale.** The list config reads it as the card price.
- **Prices carry float noise** (`3879000.0017`). The JSON-LD price is the rounded one.

## Refreshing

Capture through Zyte, not directly: ebikeshop has not agreed to direct fetching. Keep the trimming
(the Inertia chrome — routes, menus, cart — is most of each page), and update this table.
