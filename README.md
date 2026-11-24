# Economic Bearings — energy data

Free data feed for the **Energy Terminal** dashboard (Framer) on economicbearings.com.
It replaces `terminal.centreforenergy.org` and `centreforenergy.org` (offline), **in the same format**:
the dashboard does not change, only its address does.

```
GitHub Actions (every 3 h)  →  python build.py  →  public/  →  Cloudflare Pages
                                                              https://economic-bearings-data.pages.dev
                                                                /api/v1/*.json
                                                                /data/indicators/*.csv
```

## Sources (all free, no paid licence)

| File | Dashboard panels | Source |
|---|---|---|
| `crude.json` | Energy benchmarks, ticker | U.S. EIA spot prices via FRED (daily) |
| `fred.json` | Commodities, Signals | IMF via FRED (monthly) |
| `eiaweekly.json` | US fundamentals, Signals | U.S. EIA via FRED (weekly) |
| `fx.json` | FX watchlist, Country | ExchangeRate-API (160 currencies, including NGN) |
| `fxhist.json` | FX history, Signals | ECB via Frankfurter |
| `entsoe.json` | European power hour by hour | Energy-Charts / Fraunhofer ISE (ENTSO-E data) |
| `ember.json` | Power mix, map "Clean power" and "Carbon intensity" | Ember + Energy Institute via Our World in Data |
| `eiaintl.json` | World producers, Country table | Energy Institute Statistical Review via OWID |
| `worldbank.json` | Country (region, capital), World energy | World Bank |
| `solar.json` | Sun today | Open-Meteo |
| `retailfuel.json` | Pump prices | EU Weekly Oil Bulletin + U.S. EIA |
| `equities.json` | Energy equities | Stooq (daily close, best effort) |
| `news.json`, `rapidnews.json` | Newsroom, News search | RSS (EIA, Carbon Brief, OilPrice, Google News) |
| `events.json` | Calendar | **you**: the `events` list in `config.json` |
| `data/indicators/*.csv` | Map, rankings, Country tiles | World Bank WDI (refreshed automatically) |

If a source fails, **the previous file stays online** (marked `stale`). Status page:
`https://economic-bearings-data.pages.dev/` and `/api/v1/status.json`.

## One-time setup (about 10 minutes)

1. **GitHub secrets** (repo → Settings → Secrets and variables → Actions → *New repository secret*):
   - `FRED_API_KEY` = your FRED key
   - `CLOUDFLARE_ACCOUNT_ID` = Cloudflare dashboard → *Workers & Pages* → right-hand column "Account ID"
   - `CLOUDFLARE_API_TOKEN` = Cloudflare → My Profile → API Tokens → *Create Token* →
     "Custom token" → permission **Account / Cloudflare Pages / Edit** → Create
2. **GitHub variable** (same page, *Variables* tab): `SITE_URL` = `https://economic-bearings-data.pages.dev`
   (it lets the script keep the previous files if a source fails).
3. **Actions** tab → *Update energy data* → **Run workflow**. After 2–4 minutes the site is online.
4. **Framer**: paste the new `framer/EnergyTerminal.tsx` into your code component (it already points to the new
   address), or just change **API base** and **CSV base** to `https://economic-bearings-data.pages.dev`
   and empty **CSV proxy**.

### Optional: your own domain
Cloudflare → Workers & Pages → `economic-bearings-data` → *Custom domains* → `data.economicbearings.com`.
Then put this address in **API base** / **CSV base** in Framer (and in the `SITE_URL` variable).

## Adding an event to the calendar
In `config.json`, in `"events"`:
```json
{"title": "Africa Energy Forum", "start": "2027-06-15", "end": "2027-06-18", "location": "Cape Town", "url": "https://..."}
```
Commit → the site updates itself.

## Running it locally
```
pip install openpyxl
FRED_API_KEY=xxxx python build.py     # result in public/
```
