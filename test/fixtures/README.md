# Fixtures

Trimmed real samples only, never invented data (see CLAUDE.md > Conventions).
Every `api_key=` value is replaced with `REDACTED`.

| Path | Contents |
|---|---|
| `raw/` | 2 docs per raw collection, for the seed integration test (T02) |
| `xbyte/locations.json` | 1 location doc, 5 results: incl. Al Zaab (1468, the listing area) and both `industrial-area` slugs (3892, 5625) |
| `xbyte/restaurants.json` | a normal al-zaab page (first 6 rows), the "Page limit exceeded" doc, the `{"error": ""}` doc |
| `xbyte/menus.json` | `6a607b4c…393e` "not restaurant page" error; `…3948` outlet 34858 / vendor 19770, Picks and Bites share 2796833705 (trimmed to Picks plus the categories it overlaps, and one more); `…5d76` outlet 749293, float prices and a null image (whole); `…39dd` outlet 708121, "Offers" and "Add On" share 2583617858 (whole) |

The xbyte fixtures were extracted from the seeded `provider_raw` with mongosh
(`EJSON.stringify(…, { relaxed: true })`). Tests that need a broken input build a
**constructed** variant of a real doc in the test itself and say so.
