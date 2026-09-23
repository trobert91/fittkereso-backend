# Árukereső feed fixtures

Three files, **the same 22 products**, one per supported format. They are the test basis for
`ArukeresoFeedParserService`'s core claim: *every supported format converts to one common type.*

| File | Delimiter | Header spelling | Quote escaping |
|---|---|---|---|
| `speedbike-feed-sample.xml` | — | `snake_case` (+ `FreeDelivery`, `BasketDisabled`, `garancia`) | n/a — CDATA |
| `speedbike-feed-sample.csv` | `;` | `lowercase`, separators stripped | doubled — `""x""` |
| `speedbike-feed-sample.tsv` | tab | `PascalCase` | backslash — `\"x\"` |

The three spellings are deliberate. Árukereső renamed its fields in July 2021 and left the old names
valid with no published mapping, so three families are already in the wild — the official PascalCase,
the docs' own lowercase CSV header, and ShopRenter's snake_case. **A parser must match field names
case-insensitively with `_`, `-` and spaces stripped**, or it will silently read nothing from two of
these three files. Both escape styles are likewise mandated by the docs.

## Provenance

Captured 2026-09-22 from the live ShopRenter feed:

```
https://speedbike.hu/api/?route=export/feed&id=arukereso
```

`HTTP 200 · text/xml; charset=utf-8 · 26,434,609 bytes · 3488 products · ~4s`

## Facts measured across the whole live feed

Not just this sample — these drove the fixture selection and several design decisions:

- **No tag is ever absent.** Empty fields are emitted as empty elements, so a parser must treat
  empty-string as absent rather than testing for tag presence.
- `identifier`, `price`, `net_price`, `category`, `manufacturer`, `name`, `product_url`: always filled.
- `sku` empty on **891 / 3488**; `ean_code` empty on **626**; `image_url` on **47**; `description` on **149**.
- **`garancia` and `delivery_time` are always empty** — so `DeliveryTime: "NO"`, the spec's only
  "not orderable" signal, never fires on this feed. That is not the same as having no
  availability: a shop generates its feed from what it is currently offering, so **presence in
  the feed is itself the in-stock signal**, and the importer defaults to `in_stock` unless the
  feed says otherwise. The config maps `delivery_time` anyway, so a later non-empty value is
  read rather than ignored.
- **408 products have neither `sku` nor `ean_code`** — these are why the URL-slug `externalId` fallback
  exists.
- **2090 / 3488** sit under an `E-BIKE` category path.
- **70,482 of 121,428 attribute values (58%) carry leading whitespace** and need trimming.
- `product_url` is always UTM-tagged (`?utm_source=arukereso&utm_medium=cpp&…`) and must be
  canonicalized before being used as identity.
- Prices are integers here, but the Árukereső docs' own examples use a **comma decimal separator**
  (`379,97`), so the parser must handle both.
- Descriptions are raw shop HTML, including MS-Word conditional markup (`<!--[if gte mso 9]><xml>…`).
  One record keeps its full 39,967-character description as the CDATA stress case.

## What each product covers

Every record in the XML carries an XML comment saying why it is there:

- 2 × no `<attributes>` element at all
- 3 × neither `sku` nor `ean_code` — exercises the URL-slug fallback
- 2 × empty `sku` with an `ean_code`, 2 × the reverse
- 1 × empty `image_url`, 1 × empty `description`
- 1 × full HTML description kept verbatim (CDATA stress)
- 2 × rich spec table (50 attributes)
- 3 × non-E-BIKE category — must be *excluded* by the category gate
- 2 × size variants sharing `sku` 804200 with different `ean_code` and URL
- the rest ordinary complete E-BIKE records

Attribute names are a realistic mix of Hungarian (`Váz`, `Villa`, `Motor`) and English
(`frame`, `fork`, `shock`) — 212 distinct names across 623 pairs — so `specMapping` label matching is
tested against both.

## One known, intended difference

**TSV descriptions have newlines flattened to spaces; XML and CSV are byte-identical.** The Árukereső
docs explicitly permit this for TSV ("a TSV esetében az adatmezőkben lévő tabok szóközre cserélhetőek"),
and it is what makes TSV simpler to emit in practice. Seven records differ this way.

So the equivalence assertion is: **all fields and all attributes identical across the three formats;
`description` identical between XML and CSV, and equal modulo whitespace collapsing in TSV.** Do not
"fix" the TSV file to match — the difference is the point, and a parser that cannot cope with it would
fail on real TSV feeds.

## Regenerating

The XML is a trimmed slice of the live feed (descriptions cut to 240 chars except the stress record);
the CSV and TSV are derived from it. Re-capture only if the field set changes — the measured counts
above would then need re-measuring too.
