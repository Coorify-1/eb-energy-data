#!/usr/bin/env python3
"""
Economic Bearings - energy data
Builds the files the Framer "Energy Terminal" component reads:

  public/api/v1/<name>.json       (same format as the old terminal.centreforenergy.org)
  public/data/indicators/<slug>.csv

Free sources with no keys: FRED (St. Louis Fed / US EIA / IMF), ECB via Frankfurter,
ExchangeRate-API (open access), World Bank, Our World in Data (Energy Institute + Ember),
Energy-Charts (Fraunhofer ISE, ENTSO-E data), Open-Meteo, EU Weekly Oil Bulletin, RSS feeds.

If a source fails, the previous file (still online at SITE_URL) is kept:
the dashboard never goes blank because of one source.

Usage:  python build.py            (SITE_URL=https://xxx.pages.dev to keep old files)
"""
import concurrent.futures as cf
import csv
import datetime as dt
import email.utils
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "public")
API = os.path.join(OUT, "api", "v1")
IND = os.path.join(OUT, "data", "indicators")
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
UA = "EconomicBearingsEnergyData/1.0 (+https://github.com)"
NOW = dt.datetime.now(dt.timezone.utc)
CFG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
REPORT = []


def log(name, ok, msg=""):
    REPORT.append((name, ok, msg))
    print(("OK   " if ok else "FAIL ") + name + ("  " + msg if msg else ""), flush=True)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def get(url, timeout=60, tries=3, binary=False):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode("utf-8-sig", "replace")
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{url} -> {last}")


def get_json(url, **kw):
    return json.loads(get(url, **kw))


def pmap(fn, items, workers=8):
    with cf.ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def iso_now():
    return NOW.strftime("%Y-%m-%dT%H:%M:%SZ")


def envelope(data, name, publisher, url, licence):
    return {
        "status": "live",
        "retrievedAt": iso_now(),
        "source": {"name": name, "publisher": publisher, "url": url, "licence": licence},
        "data": data,
    }


def write_api(name, payload):
    os.makedirs(API, exist_ok=True)
    with open(os.path.join(API, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))


def keep_previous(name):
    """Source failed: copy the file currently online, marked as stale."""
    if not SITE_URL:
        return False
    try:
        old = get_json(f"{SITE_URL}/api/v1/{name}.json", tries=2)
        old["status"] = "stale"
        write_api(name, old)
        return True
    except Exception:
        return False


def job(name):
    """Decorator: run a builder, fall back to the previous file on error."""
    def deco(fn):
        def run():
            try:
                payload, note = fn()
                write_api(name, payload)
                log(name, True, note)
            except Exception as e:  # noqa
                kept = keep_previous(name)
                log(name, False, f"{e}" + (" (previous file kept)" if kept else ""))
        run.__name__ = name
        return run
    return deco


# --------------------------------------------------------------------------- #
# FRED (no key: fredgraph.csv)
# --------------------------------------------------------------------------- #

FRED_KEY = os.environ.get("FRED_API_KEY", "").strip()


def fred_series(sid, start=None):
    """Official FRED API when FRED_API_KEY is set (GitHub secret), else the public CSV."""
    if FRED_KEY:
        try:
            q = {"series_id": sid, "api_key": FRED_KEY, "file_type": "json"}
            if start:
                q["observation_start"] = start
            j = get_json("https://api.stlouisfed.org/fred/series/observations?" + urllib.parse.urlencode(q))
            pts = []
            for o in j.get("observations", []):
                try:
                    pts.append({"date": o["date"][:10], "value": round(float(o["value"]), 4)})
                except (ValueError, KeyError):
                    continue
            if len(pts) >= 3:
                return pts
        except Exception as e:  # noqa
            print("   FRED API", sid, "->", str(e).replace(FRED_KEY, "***"), "; trying CSV")
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + sid
    if start:
        url += "&cosd=" + start
    rows = list(csv.reader(io.StringIO(get(url))))
    pts = []
    for r in rows[1:]:
        if len(r) < 2:
            continue
        try:
            v = float(r[1])
        except ValueError:
            continue  # "." = no value that day
        pts.append({"date": r[0][:10], "value": round(v, 4)})
    if len(pts) < 3:
        raise RuntimeError(sid + ": no data")
    return pts


def fred_block(items, start):
    days = (NOW - dt.datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)).days

    def one(it):
        try:
            s = None
            if it.get("eia"):
                try:
                    s = eia_weekly(it["eia"], it.get("freq", "d"), days)
                except Exception as e:  # noqa
                    print("   EIA", it["eia"], e, "; trying FRED")
            s = s or fred_series(it["id"], start)
            return {"id": it["id"], "name": it["name"], "unit": it["unit"],
                    "date": s[-1]["date"], "series": s}
        except Exception as e:  # noqa
            print("   skip", it["id"], e)
            return None
    out = [x for x in pmap(one, items, 3) if x]
    if not out:
        raise RuntimeError("no series answered (EIA / FRED)")
    return out


def ago(days):
    return (NOW - dt.timedelta(days=days)).strftime("%Y-%m-%d")


@job("crude")
def build_crude():
    d = fred_block(CFG["benchmarks"], ago(400))
    return envelope(d, "Spot prices", "U.S. EIA",
                    "https://www.eia.gov/petroleum/data.php", "Public domain"), f"{len(d)} series"


@job("fred")
def build_fred():
    d = fred_block(CFG["commodities"], ago(4 * 366))
    return envelope(d, "IMF Primary Commodity Prices via FRED", "IMF via FRED",
                    "https://fred.stlouisfed.org", "Public domain"), f"{len(d)} series"


def eia_weekly(sid, freq="w", since_days=400):
    """U.S. EIA history file (.xls), no key: https://www.eia.gov/dnav/pet/hist_xls/<ID><d|w|m>.xls"""
    import xlrd  # installed by the workflow
    folder = "ng" if sid.startswith(("NW", "RNG", "N9")) else "pet"
    raw = get(f"https://www.eia.gov/dnav/{folder}/hist_xls/{sid}{freq}.xls", timeout=60, binary=True)
    book = xlrd.open_workbook(file_contents=raw)
    sh = book.sheet_by_name("Data 1") if "Data 1" in book.sheet_names() else book.sheet_by_index(1)
    pts = []
    for i in range(sh.nrows):
        a, b = sh.cell(i, 0), sh.cell(i, 1)
        if a.ctype == xlrd.XL_CELL_DATE and b.ctype == xlrd.XL_CELL_NUMBER:
            d = xlrd.xldate.xldate_as_datetime(a.value, book.datemode).strftime("%Y-%m-%d")
            if d >= ago(since_days):
                pts.append({"date": d, "value": round(b.value, 3)})
    if len(pts) < 3:
        raise RuntimeError(sid + ": no data")
    return pts


@job("eiaweekly")
def build_eiaweekly():
    def one(it):
        try:
            s = None
            if it.get("eia"):
                try:
                    s = eia_weekly(it["eia"], "w")
                except Exception as e:  # noqa
                    print("   EIA", it["eia"], e, "; trying FRED")
            s = s or fred_series(it["id"], ago(400))
            return {"id": it["id"], "name": it["name"], "unit": it["unit"], "date": s[-1]["date"], "series": s}
        except Exception as e:  # noqa
            print("   skip", it["id"], e)
            return None
    d = [x for x in pmap(one, CFG["us_weekly"], 3) if x]
    if not d:
        raise RuntimeError("no weekly series answered")
    return envelope(d, "Weekly Petroleum Status Report", "U.S. EIA",
                    "https://www.eia.gov/petroleum/supply/weekly/", "Public domain"), f"{len(d)} series"


# --------------------------------------------------------------------------- #
# FX
# --------------------------------------------------------------------------- #

@job("fx")
def build_fx():
    try:
        j = get_json("https://open.er-api.com/v6/latest/USD")
        rates = j["rates"]
        day = dt.datetime.fromtimestamp(j["time_last_update_unix"], dt.timezone.utc).strftime("%Y-%m-%d")
        pub, url = "ExchangeRate-API", "https://www.exchangerate-api.com"
    except Exception:
        j = frankfurter("/latest?from=USD")
        rates, day = j["rates"], j["date"]
        pub, url = "ECB via Frankfurter", "https://frankfurter.dev"
    rates = {k: v for k, v in rates.items() if k != "USD"}
    data = {"base": "USD", "date": day, "usd": rates}
    return envelope(data, "Exchange rates", pub, url, "Free, attribution"), f"{len(rates)} currencies"


def frankfurter(path):
    last = None
    for host in ("https://api.frankfurter.dev/v1", "https://api.frankfurter.app"):
        try:
            return get_json(host + path)
        except Exception as e:  # noqa
            last = e
    raise RuntimeError(last)


@job("fxhist")
def build_fxhist():
    cur = ",".join(CFG["fx_history"])
    j = frankfurter(f"/{ago(400)}..?from=USD&to={cur}")
    out = {c: [] for c in CFG["fx_history"]}
    for day in sorted(j["rates"]):
        for c, v in j["rates"][day].items():
            if c in out:
                out[c].append({"date": day, "value": round(v, 6)})
    out = {k: v for k, v in out.items() if v}
    return envelope({"usd": out}, "ECB reference rates", "ECB via Frankfurter",
                    "https://frankfurter.dev", "Free"), f"{len(out)} currencies"


# --------------------------------------------------------------------------- #
# European power, day-ahead (Energy-Charts, Fraunhofer ISE)
# --------------------------------------------------------------------------- #

@job("entsoe")
def build_power():
    def one(z):
        code, name = z
        try:
            j = None
            for wait in (0, 4, 10, 20):
                time.sleep(wait or 1.2)
                try:
                    j = get_json("https://api.energy-charts.info/price?bzn=" + urllib.parse.quote(code),
                                 timeout=40, tries=1)
                    break
                except Exception as e:  # noqa
                    if "429" not in str(e):
                        raise
            if j is None:
                raise RuntimeError("429 rate limit")
            ts, pr = j.get("unix_seconds") or [], j.get("price") or []
            pts = [{"time": dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                    "value": round(p, 2)} for t, p in zip(ts, pr) if p is not None]
            if len(pts) < 20:
                return None
            # keep only the last delivery day (24 h or 96 quarter hours)
            n = 96 if len(pts) >= 96 and (ts[1] - ts[0]) <= 900 else 24
            pts = pts[-n:]
            avg = sum(p["value"] for p in pts) / len(pts)
            return {"name": name, "zone": code, "unit": "EUR/MWh",
                    "avg": round(avg, 2), "series": pts}
        except Exception as e:  # noqa
            print("   skip", code, e)
            return None
    rows = [r for r in map(one, CFG["power_zones"]) if r]  # one by one: the API rate-limits
    if len(rows) < 3:
        raise RuntimeError("too few bidding zones")
    first = rows[0]["series"][0]["time"]
    # delivery day in Brussels time (CET = UTC+1, good enough for a date label)
    day = (dt.datetime.strptime(first, "%Y-%m-%dT%H:%MZ") + dt.timedelta(hours=2)).strftime("%Y-%m-%d")
    return envelope({"date": day, "zones": rows}, "Day-ahead prices (ENTSO-E data)",
                    "Energy-Charts / Fraunhofer ISE", "https://energy-charts.info",
                    "CC BY 4.0"), f"{len(rows)} zones, {day}"


# --------------------------------------------------------------------------- #
# Our World in Data energy (Energy Institute Statistical Review + Ember)
# --------------------------------------------------------------------------- #

OWID_URL = "https://raw.githubusercontent.com/owid/energy-data/master/owid-energy-data.csv"
_owid = None


def owid():
    global _owid
    if _owid is None:
        _owid = list(csv.DictReader(io.StringIO(get(OWID_URL, timeout=120))))
    return _owid


def iso_of(r):
    c = (r.get("iso_code") or "").strip()
    if c == "OWID_WRL" or (not c and (r.get("country") or "").strip() == "World"):
        return "WLD"
    return c if re.fullmatch(r"[A-Z]{3}", c) else None


def f(r, k):
    try:
        v = r.get(k)
        return None if v in (None, "") else float(v)
    except ValueError:
        return None


FUEL_COLS = [
    ("Coal", "coal_electricity"), ("Gas", "gas_electricity"), ("Other fossil", "oil_electricity"),
    ("Nuclear", "nuclear_electricity"), ("Hydro", "hydro_electricity"), ("Wind", "wind_electricity"),
    ("Solar", "solar_electricity"), ("Bioenergy", "biofuel_electricity"),
]


@job("ember")
def build_ember():
    best = {}
    for r in owid():
        iso = iso_of(r)
        if not iso:
            continue
        tot = f(r, "electricity_generation")
        fuels = {n: f(r, c) for n, c in FUEL_COLS}
        if tot is None or sum(v is not None for v in fuels.values()) < 3:
            continue
        y = int(r["year"])
        if iso not in best or y > best[iso]["year"]:
            item = {"year": y, "total": round(tot, 2),
                    "twh": {n: round(v, 3) for n, v in fuels.items() if v is not None}}
            lc = f(r, "low_carbon_share_elec")
            ci = f(r, "carbon_intensity_elec")
            if lc is not None:
                item["clean_share"] = round(lc, 2)
            if ci is not None:
                item["carbon_intensity"] = round(ci, 1)
            best[iso] = item
    if len(best) < 50:
        raise RuntimeError("OWID: too few countries")
    data = {"mix": best,
            "intensity": {k: v["carbon_intensity"] for k, v in best.items() if "carbon_intensity" in v}}
    return envelope(data, "Electricity mix (Ember, Energy Institute)", "Ember / Energy Institute via OWID",
                    "https://ourworldindata.org/energy", "CC BY 4.0"), f"{len(best)} countries"


PROD = [
    ("oil_production", "Oil production", "TWh"),
    ("gas_production", "Natural gas production", "TWh"),
    ("coal_production", "Coal production", "TWh"),
    ("electricity_generation", "Electricity generation", "TWh"),
    ("renewables_electricity", "Renewable electricity generation", "TWh"),
    ("primary_energy_consumption", "Primary energy consumption", "TWh"),
]


@job("eiaintl")
def build_producers():
    first = NOW.year - 26
    out = []
    for col, name, unit in PROD:
        vals = {}
        for r in owid():
            iso = iso_of(r)
            v = f(r, col)
            if not iso or v is None or int(r["year"]) < first:
                continue
            vals.setdefault(iso, []).append({"year": int(r["year"]), "value": round(v, 2)})
        for a in vals.values():
            a.sort(key=lambda p: p["year"])
        if vals:
            out.append({"id": col, "name": name, "unit": unit, "decimals": 0, "values": vals})
    if not out:
        raise RuntimeError("OWID: no production columns")
    return envelope(out, "Statistical Review of World Energy", "Energy Institute via OWID",
                    "https://ourworldindata.org/energy", "CC BY 4.0"), f"{len(out)} metrics"


# --------------------------------------------------------------------------- #
# World Bank: countries + world aggregates + the 6 indicator CSVs
# --------------------------------------------------------------------------- #

WB = "https://api.worldbank.org/v2"
CSV_SERIES = {
    "electricity-access": "EG.ELC.ACCS.ZS",
    "renewable-electricity-share": "EG.ELC.RNEW.ZS",
    "co2-per-capita": "EN.GHG.CO2.PC.CE.AR5",
    "power-consumption-per-capita": "EG.USE.ELEC.KH.PC",
    "clean-cooking": "EG.CFT.ACCS.ZS",
    "gdp-per-capita": "NY.GDP.PCAP.CD",
}
WORLD_SERIES = [
    ("EG.ELC.ACCS.ZS", "access to electricity (% of population)", "%"),
    ("EG.ELC.RNEW.ZS", "renewable electricity output (% of total)", "%"),
    ("EN.GHG.CO2.MT.CE.AR5", "total co2 emissions (Mt CO2e)", "Mt"),
    ("EG.EGY.PRIM.PP.KD", "energy intensity level of primary energy (MJ/$2017 PPP GDP)", "MJ/$"),
]


def wb_indicator(code, iso="all", since=1990):
    url = f"{WB}/country/{iso}/indicator/{code}?format=json&per_page=20000&date={since}:{NOW.year}"
    j = get_json(url, timeout=120)
    if not isinstance(j, list) or len(j) < 2 or not j[1]:
        raise RuntimeError(code + ": empty")
    return j[1]


def build_csvs():
    """Refresh the 6 CSVs. On failure keep the copy stored in the repo (data/indicators)."""
    os.makedirs(IND, exist_ok=True)
    src_dir = os.path.join(ROOT, "data", "indicators")
    for slug, code in CSV_SERIES.items():
        target = os.path.join(IND, slug + ".csv")
        stored = os.path.join(src_dir, slug + ".csv")
        try:
            rows = wb_indicator(code)
            unit = ""
            if os.path.exists(stored):  # reuse the friendly unit label of the stored file
                with open(stored, encoding="utf-8-sig") as fh:
                    first = next(csv.DictReader(fh), None)
                    unit = (first or {}).get("unit", "")
            out = []
            for r in rows:
                if r.get("value") is None or not r.get("countryiso3code"):
                    continue
                out.append([r["countryiso3code"], r["country"]["value"], r["date"],
                            round(float(r["value"]), 4), unit or r.get("unit") or "", code,
                            "World Bank, World Development Indicators", "CC BY 4.0", iso_now()])
            if len(out) < 1000:
                raise RuntimeError(f"only {len(out)} rows")
            out.sort(key=lambda x: (x[0], int(x[2])))
            with open(target, "w", encoding="utf-8", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["country_iso3", "country", "year", "value", "unit", "series_code",
                            "source", "licence", "retrieved_at"])
                w.writerows(out)
            shutil.copyfile(target, stored)  # the workflow commits it back = always a good copy
            log("csv " + slug, True, f"{len(out)} rows")
        except Exception as e:  # noqa
            if os.path.exists(stored):
                shutil.copyfile(stored, target)
            log("csv " + slug, False, f"{e} (stored copy used)")


@job("worldbank")
def build_worldbank():
    j = get_json(f"{WB}/country?format=json&per_page=400", timeout=90)
    countries = []
    for c in j[1]:
        countries.append({
            "id": c["id"], "iso2Code": c.get("iso2Code"), "name": c["name"],
            "region": (c.get("region") or {}).get("value"),
            "incomeLevel": (c.get("incomeLevel") or {}).get("value"),
            "capitalCity": c.get("capitalCity") or None,
            "latitude": c.get("latitude") or None, "longitude": c.get("longitude") or None,
        })
    world = []
    for code, label, unit in WORLD_SERIES:
        try:
            rows = [r for r in wb_indicator(code, "WLD", 2000) if r.get("value") is not None]
            r = max(rows, key=lambda x: int(x["date"]))
            world.append({"iso3": "WLD", "country": "World", "indicator": f"{code} {label}",
                          "year": int(r["date"]), "value": round(float(r["value"]), 4), "unit": unit})
        except Exception as e:  # noqa
            print("   skip", code, e)
    # newer world shares from Ember / Energy Institute
    try:
        wr = [r for r in owid() if iso_of(r) == "WLD"]
        for col, label in [("coal_share_elec", "coal share of electricity"),
                           ("renewables_share_elec", "renewable share of electricity output")]:
            pts = [(int(r["year"]), f(r, col)) for r in wr if f(r, col) is not None]
            if pts:
                y, v = max(pts)
                world.append({"iso3": "WLD", "country": "World", "indicator": label,
                              "year": y, "value": round(v, 2), "unit": "%"})
    except Exception as e:  # noqa
        print("   skip owid world", e)
    return envelope({"countries": countries, "world": world}, "World Development Indicators",
                    "World Bank", "https://data.worldbank.org", "CC BY 4.0"), \
        f"{len(countries)} countries, {len(world)} world values"


# --------------------------------------------------------------------------- #
# Solar (Open-Meteo)
# --------------------------------------------------------------------------- #

@job("solar")
def build_solar():
    cities = CFG["solar_cities"]
    q = urllib.parse.urlencode({
        "latitude": ",".join(str(c[2]) for c in cities),
        "longitude": ",".join(str(c[3]) for c in cities),
        "daily": "shortwave_radiation_sum,sunshine_duration",
        "timezone": "auto", "forecast_days": 7,
    })
    j = get_json("https://api.open-meteo.com/v1/forecast?" + q)
    if isinstance(j, dict):
        j = [j]
    out = []
    for c, loc in zip(cities, j):
        d = loc.get("daily") or {}
        days = []
        for day, mj, sun in zip(d.get("time", []), d.get("shortwave_radiation_sum", []),
                                d.get("sunshine_duration", [])):
            if mj is None:
                continue
            days.append({"date": day, "kwhPerM2": round(mj / 3.6, 2),
                         "sunshineHours": round((sun or 0) / 3600, 1)})
        if days:
            out.append({"name": c[0], "iso3": c[1], "days": days})
    if not out:
        raise RuntimeError("no city")
    return envelope(out, "Solar irradiation forecast", "Open-Meteo", "https://open-meteo.com",
                    "CC BY 4.0"), f"{len(out)} cities"


# --------------------------------------------------------------------------- #
# Pump prices: EU Weekly Oil Bulletin + US EIA (FRED)
# --------------------------------------------------------------------------- #

WOB_URL = ("https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en"
           "?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx")
EU_NAMES = {"AT": "Austria", "BE": "Belgium", "BG": "Bulgaria", "CY": "Cyprus", "CZ": "Czechia",
            "DE": "Germany", "DK": "Denmark", "EE": "Estonia", "ES": "Spain", "FI": "Finland",
            "FR": "France", "GR": "Greece", "EL": "Greece", "HR": "Croatia", "HU": "Hungary",
            "IE": "Ireland", "IT": "Italy", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
            "MT": "Malta", "NL": "Netherlands", "PL": "Poland", "PT": "Portugal", "RO": "Romania",
            "SE": "Sweden", "SI": "Slovenia", "SK": "Slovakia"}


def eu_pump():
    import openpyxl  # installed by the workflow
    wb = openpyxl.load_workbook(io.BytesIO(get(WOB_URL, timeout=180, binary=True)),
                                read_only=True, data_only=True)
    ws = None
    for name in wb.sheetnames:
        if "with tax" in name.lower() and "without" not in name.lower():
            ws = wb[name]
            break
    ws = ws or wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    cols = {}
    hdr_found = False
    latest = None
    for row in rows:
        if not hdr_found:
            for i, h in enumerate(row):
                m = re.match(r"^([A-Z]{2})_price_with_tax_(euro_?super_?95|euro95)", str(h or ""), re.I)
                if m:
                    cols.setdefault(m.group(1).upper(), {})["p"] = i
                m = re.match(r"^([A-Z]{2})_price_with_tax_diesel", str(h or ""), re.I)
                if m:
                    cols.setdefault(m.group(1).upper(), {})["d"] = i
            hdr_found = bool(cols)
            continue
        day = row[0]
        if not isinstance(day, (dt.date, dt.datetime)):
            continue
        vals = {k: row[v["p"]] for k, v in cols.items() if "p" in v and v["p"] < len(row)}
        if sum(isinstance(x, (int, float)) for x in vals.values()) < 10:
            continue
        if latest is None or day > latest[0]:
            latest = (day, row)
    if not latest:
        raise RuntimeError("bulletin layout not recognised")
    day, row = latest
    out = []
    for cc, idx in cols.items():
        p = row[idx["p"]] if "p" in idx else None
        d = row[idx["d"]] if "d" in idx and idx["d"] < len(row) else None
        if not isinstance(p, (int, float)):
            continue
        k = 1000.0 if p > 20 else 1.0  # the bulletin gives EUR per 1000 litres
        item = {"country": EU_NAMES.get(cc, cc), "code": cc, "petrol": round(p / k, 3)}
        if isinstance(d, (int, float)):
            item["diesel"] = round(d / k, 3)
        out.append(item)
    return day.strftime("%Y-%m-%d"), out


@job("retailfuel")
def build_fuel():
    data, notes = {}, []
    try:
        day, eu = eu_pump()
        data["europe"] = {"date": day, "unit": "EUR/litre", "countries": eu}
        notes.append(f"EU {len(eu)} countries {day}")
    except Exception as e:  # noqa
        print("   EU bulletin:", e)
    try:
        try:
            p = eia_weekly("EMM_EPMR_PTE_NUS_DPG", "w", 60)[-1]
            d = eia_weekly("EMD_EPD2D_PTE_NUS_DPG", "w", 60)[-1]
        except Exception:
            p = fred_series("GASREGW", ago(60))[-1]
            d = fred_series("GASDESW", ago(60))[-1]
        data["us"] = {"name": "United States", "iso3": "USA", "date": p["date"], "unit": "USD/gallon",
                      "petrol": p["value"], "diesel": d["value"]}
        notes.append("US " + p["date"])
    except Exception as e:  # noqa
        print("   US retail:", e)
    if not data:
        raise RuntimeError("no pump price source answered")
    return envelope(data, "Retail fuel prices", "EU Weekly Oil Bulletin / U.S. EIA",
                    "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en",
                    "Free, attribution"), ", ".join(notes)


# --------------------------------------------------------------------------- #
# Equities (Stooq daily close, best effort)
# --------------------------------------------------------------------------- #

@job("equities")
def build_equities():
    def one(e):
        sym, name, grp = e
        try:
            txt = get(f"https://stooq.com/q/d/l/?s={sym}&i=d&d1={ago(20).replace('-', '')}", tries=2)
            rows = [r for r in csv.reader(io.StringIO(txt)) if r and re.match(r"\d{4}-", r[0])]
            if len(rows) < 2:
                return None
            c0, c1 = float(rows[-2][4]), float(rows[-1][4])
            return {"name": name, "symbol": sym.split(".")[0].upper(), "group": grp,
                    "currency": "USD", "price": round(c1, 2),
                    "changePct": round((c1 - c0) / c0 * 100, 2), "date": rows[-1][0]}
        except Exception:
            return None
    out = [x for x in pmap(one, CFG["equities"], 4) if x]
    src = "Stooq"
    if not out:
        def yahoo(e):
            sym, name, grp = e
            try:
                t = sym.split(".")[0].upper()
                j = get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=10d&interval=1d", tries=2)
                r = j["chart"]["result"][0]
                closes = [c for c in r["indicators"]["quote"][0]["close"] if c is not None]
                if len(closes) < 2:
                    return None
                day = dt.datetime.fromtimestamp(r["timestamp"][-1], dt.timezone.utc).strftime("%Y-%m-%d")
                return {"name": name, "symbol": t, "group": grp, "currency": r["meta"].get("currency", "USD"),
                        "price": round(closes[-1], 2),
                        "changePct": round((closes[-1] - closes[-2]) / closes[-2] * 100, 2), "date": day}
            except Exception:
                return None
        out = [x for x in pmap(yahoo, CFG["equities"], 3) if x]
        src = "Yahoo Finance"
    if not out:
        raise RuntimeError("Stooq did not answer (remove the Energy equities panel if this persists)")
    return envelope(out, "Daily close", src, "", "Free, delayed"), f"{len(out)} stocks"


# --------------------------------------------------------------------------- #
# News (RSS) and events (config.json)
# --------------------------------------------------------------------------- #

def rss(feeds, limit=40):
    items = []
    for src, url in feeds:
        try:
            root = ET.fromstring(get(url, timeout=30, tries=2).encode("utf-8"))
        except Exception as e:  # noqa
            print("   feed", src, e)
            continue
        ns_atom = "{http://www.w3.org/2005/Atom}"
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            pub = it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date") or ""
            source = src
            s = it.find("source")
            if s is not None and (s.text or "").strip():
                source = s.text.strip()
                title = re.sub(r"\s+-\s+" + re.escape(source) + r"$", "", title)
            items.append((title, link, source, pub))
        for it in root.iter(ns_atom + "entry"):
            l = it.find(ns_atom + "link")
            items.append(((it.findtext(ns_atom + "title") or "").strip(),
                          l.get("href") if l is not None else "", src,
                          it.findtext(ns_atom + "updated") or ""))
    out, seen = [], set()
    for title, link, source, pub in items:
        key = re.sub(r"\W", "", title.lower())[:80]
        if not title or key in seen:
            continue
        seen.add(key)
        try:
            d = email.utils.parsedate_to_datetime(pub).astimezone(dt.timezone.utc)
        except Exception:
            try:
                d = dt.datetime.fromisoformat(pub.replace("Z", "+00:00"))
            except Exception:
                d = NOW
        out.append({"title": title, "url": link, "source": source,
                    "publishedAt": d.strftime("%Y-%m-%dT%H:%M:%SZ")})
    out.sort(key=lambda x: x["publishedAt"], reverse=True)
    if not out:
        raise RuntimeError("no feed answered")
    return out[:limit]


@job("news")
def build_news():
    d = rss(CFG["news_feeds"])
    return envelope(d, "Energy news", "RSS feeds", "", "Headlines and links only"), f"{len(d)} headlines"


@job("rapidnews")
def build_search():
    d = rss(CFG["search_feeds"])
    return envelope(d, "Energy news search", "Google News RSS", "https://news.google.com",
                    "Headlines and links only"), f"{len(d)} headlines"


@job("events")
def build_events():
    today = NOW.strftime("%Y-%m-%d")
    ev = [e for e in CFG.get("events", []) if str(e.get("end") or e.get("start", ""))[:10] >= today]
    ev.sort(key=lambda e: e.get("start", ""))
    return envelope(ev, "Events calendar", "Economic Bearings", "", ""), f"{len(ev)} events"


# --------------------------------------------------------------------------- #

def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(API, exist_ok=True)
    jobs = [build_crude, build_fred, build_eiaweekly, build_fx, build_fxhist, build_power,
            build_ember, build_producers, build_worldbank, build_solar, build_fuel,
            build_equities, build_news, build_search, build_events]
    try:
        owid()  # download once, shared by 3 builders
    except Exception as e:  # noqa
        print("OWID download failed:", e)
    pmap(lambda fn: fn(), jobs, 6)
    build_csvs()

    # static extras: CORS headers, cache, a small index page and a status file
    with open(os.path.join(OUT, "_headers"), "w") as fh:
        fh.write("/*\n  Access-Control-Allow-Origin: *\n  Access-Control-Allow-Methods: GET, OPTIONS\n"
                 "  Cache-Control: public, max-age=600\n  X-Content-Type-Options: nosniff\n")
    status = {"builtAt": iso_now(), "results": [{"name": n, "ok": ok, "note": m} for n, ok, m in REPORT]}
    with open(os.path.join(API, "status.json"), "w") as fh:
        json.dump(status, fh, indent=1)
    rows = "".join(f"<tr><td>{'✅' if ok else '⚠️'}</td><td><a href='api/v1/{n}.json'>{n}</a></td>"
                   f"<td>{m}</td></tr>" if not n.startswith("csv") else
                   f"<tr><td>{'✅' if ok else '⚠️'}</td><td><a href='data/indicators/{n[4:]}.csv'>{n}</a></td>"
                   f"<td>{m}</td></tr>" for n, ok, m in REPORT)
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as fh:
        fh.write("<!doctype html><meta charset=utf-8><title>Economic Bearings energy data</title>"
                 "<style>body{font:14px system-ui;margin:40px;max-width:900px}td{padding:4px 10px;"
                 "border-bottom:1px solid #eee}</style><h1>Economic Bearings energy data</h1>"
                 f"<p>Last build: {iso_now()}</p><table>{rows}</table>")
    bad = [n for n, ok, _ in REPORT if not ok]
    print(f"\nDone: {len(REPORT) - len(bad)} OK, {len(bad)} failed {bad}")
    api_bad = [n for n in bad if not n.startswith("csv")]  # CSVs always fall back to the stored copy
    if len(api_bad) > 15 // 2:
        sys.exit(1)  # something is badly wrong: do not deploy a mostly empty site


if __name__ == "__main__":
    main()
