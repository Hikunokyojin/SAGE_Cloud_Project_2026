# Catalogue sources (T3.2)

| File | What | How it enters the catalogue |
|---|---|---|
| `cloud-prices.json` | 72 AWS and Azure services, priced from the official public feeds | `npm run catalogue:import` refreshes it, then `npm run catalogue:ingest -- data/sources/cloud-prices.json` |
| `third-party-to-verify.csv` | 166 third-party services, pre-filled from memory | Check each row against its `sourceUrl`, correct the price and unit, fill `retrievedAt` (YYYY-MM-DD), delete the `TO VERIFY` note, then ingest the file |

Rows with an empty `retrievedAt` are refused by ingestion, so nothing unchecked can enter.
Prices in the sheet use the provider's own unit (per email, per MAU, percent per charge, per month);
normalising units for comparison happens in T3.4.
