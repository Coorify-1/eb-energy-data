import * as React from "react"
import { addPropertyControls, ControlType } from "framer"

/**
 * Economic Bearings Energy Terminal
 * Live energy dashboard on the Economic Bearings open data feed (free public sources):
 * Benchmarks + FX watchlist, clickable world map, Highest/Lowest tables and a Country panel
 * that follows the map click. All the original panels, tabs, ticker and search are kept.
 *
 * Extra panels (same light design): Signals, Commodities, Energy equities,
 * European power hour by hour, World producers, US fundamentals, Release calendar,
 * World energy, Sun today, Pump prices.
 *  - In the full terminal: turn them on/off and reorder them with the "Panels" list,
 *    choose full-width panels and the minimum column width.
 *  - On their own: set "Show" to one panel, or insert the named components
 *    (SignalsPanel, CommoditiesPanel, ...) exported at the bottom of this file.
 *
 * API JSON  : <API base>/api/v1/*.json            (default https://economic-bearings-data.pages.dev)
 * CSV files : <CSV base>/data/indicators/<slug>.csv (default https://economic-bearings-data.pages.dev)
 * Data built every 2 hours by GitHub Actions, served by Cloudflare Pages.
 *
 * @framerIntrinsicWidth 1240
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */

/* ------------------------------------------------------------------ */
/* Data layer                                                          */
/* ------------------------------------------------------------------ */

// Base URL of the indicator CSV files (set from the "CSV base" property)
const DATA_URL = "https://economic-bearings-data.pages.dev"
let CSV_BASE = DATA_URL

const store = new Map<string, { at: number; p: Promise<any> }>()

function cached(url: string, maxAge: number, text: boolean): Promise<any> {
    const key = (text ? "t:" : "j:") + url
    const hit = store.get(key)
    if (hit && Date.now() - hit.at < maxAge) return hit.p
    const p = fetch(
        url,
        text ? undefined : { headers: { Accept: "application/json" } }
    ).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status)
        return text ? r.text() : r.json()
    })
    store.set(key, { at: Date.now(), p })
    p.catch(() => store.delete(key))
    return p
}
const getJSON = (url: string, maxAge: number) => cached(url, maxAge, false)
const getText = (url: string, maxAge: number) => cached(url, maxAge, true)

type PanelState = {
    state: "loading" | "ok" | "error"
    json?: any
    error?: string
}

/* Last good answer of each endpoint, kept in the browser (localStorage).
   On the next visit the panel shows it at once, then refreshes in the background. */
const SAVE_PREFIX = "cet:v1:"
const SAVE_MAX = 1500000 // skip very large answers (storage quota)

function readSaved(url: string): any | undefined {
    try {
        const raw = window.localStorage.getItem(SAVE_PREFIX + url)
        if (!raw) return undefined
        const o = JSON.parse(raw)
        // older than 7 days: ignore
        if (!o || Date.now() - o.at > 7 * 864e5) return undefined
        return o.json
    } catch {
        return undefined
    }
}
function writeSaved(url: string, json: any) {
    try {
        const raw = JSON.stringify({ at: Date.now(), json })
        if (raw.length < SAVE_MAX)
            window.localStorage.setItem(SAVE_PREFIX + url, raw)
    } catch {}
}

/* Start the ticker requests as soon as the code file loads,
   before React mounts the component (same cache, so no double request). */
const TICKER_PATHS = [
    "/api/v1/crude.json",
    "/api/v1/fred.json",
    "/api/v1/fx.json",
]
function prefetchTicker(base: string) {
    if (typeof window === "undefined") return
    TICKER_PATHS.forEach((p) =>
        getJSON(base + p, 240000)
            .then((j) => writeSaved(base + p, j))
            .catch(() => {})
    )
}
prefetchTicker(DATA_URL)

function usePanel(base: string, path: string, refreshMs: number): PanelState {
    const [s, set] = React.useState<PanelState>({ state: "loading" })
    React.useEffect(() => {
        let alive = true
        const url = base + path
        // show the saved copy immediately (no waiting for the network)
        const saved = readSaved(url)
        if (saved !== undefined)
            set((p) => (p.json ? p : { state: "ok", json: saved }))
        const load = () =>
            getJSON(url, Math.max(refreshMs - 1000, 60000))
                .then((json) => {
                    if (!alive) return
                    set({ state: "ok", json })
                    writeSaved(url, json)
                })
                .catch(
                    (e) =>
                        alive &&
                        set((p) => ({
                            state: p.json ? "ok" : "error",
                            json: p.json,
                            error: String((e && e.message) || e),
                        }))
                )
        load()
        const id = setInterval(load, refreshMs)
        return () => {
            alive = false
            clearInterval(id)
        }
    }, [base, path, refreshMs])
    return s
}

/* ------------------------------------------------------------------ */
/* Shape-tolerant parsing                                              */
/* ------------------------------------------------------------------ */

const isNum = (v: any) => typeof v === "number" && isFinite(v)
const num = (v: any): number | null => {
    if (isNum(v)) return v
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.replace(/,/g, ""))
        return isFinite(n) ? n : null
    }
    return null
}
const lc = (o: any): Record<string, any> => {
    const out: Record<string, any> = {}
    if (o && typeof o === "object")
        for (const k of Object.keys(o)) out[k.toLowerCase()] = o[k]
    return out
}
const pickKey = (o: Record<string, any>, keys: string[]) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
    return undefined
}
const pickNum = (o: Record<string, any>, keys: string[]) => {
    for (const k of keys) {
        const n = num(o[k])
        if (n !== null) return n
    }
    return null
}

function collect(d: any, depth = 0): [string, any][] {
    if (d == null) return []
    if (Array.isArray(d)) return d.map((x, i) => [String(i), x])
    if (typeof d !== "object") return []
    const e = Object.entries(d)
    const arrs = e.filter(
        ([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object"
    )
    if (arrs.length) {
        arrs.sort((a, b) => (b[1] as any[]).length - (a[1] as any[]).length)
        return (arrs[0][1] as any[]).map((x, i) => [String(i), x])
    }
    const objs = e.filter(
        ([, v]) => v && typeof v === "object" && !Array.isArray(v)
    )
    const nums = e.filter(([, v]) => isNum(v))
    if (objs.length >= 3 && objs.length >= nums.length) return objs as any
    if (objs.length > 0 && depth < 3) {
        let best: [string, any][] = []
        for (const [, child] of objs) {
            const r = collect(child, depth + 1)
            if (r.length > best.length) best = r
        }
        if (best.length) return best
    }
    if (nums.length >= 2) return nums as any
    return []
}

type Row = {
    label: string
    value: number | null
    change: number | null
    pct: number | null
    unit?: string
    sub?: string
    series?: number[]
}

const LABEL_KEYS = [
    "name",
    "label",
    "title",
    "symbol",
    "country",
    "zone",
    "area",
    "city",
    "region",
    "commodity",
    "product",
    "series",
    "description",
    "id",
    "code",
]
const VALUE_KEYS = [
    "price",
    "value",
    "last",
    "close",
    "latest",
    "rate",
    "current",
    "avg",
    "average",
    "mean",
    "settle",
    "level",
    "amount",
]
const CHANGE_KEYS = [
    "change",
    "chg",
    "delta",
    "diff",
    "change_abs",
    "changeabs",
    "abschange",
]
const PCT_KEYS = [
    "changepct",
    "pctchange",
    "change_pct",
    "pct_change",
    "pct",
    "percent",
    "changepercent",
    "change_percent",
    "percentchange",
    "chg_pct",
    "pctchg",
]
const SERIES_KEYS = [
    "series",
    "history",
    "hourly",
    "prices",
    "points",
    "values",
    "trend",
    "spark",
    "sparkline",
    "hours",
]
const DATE_KEYS = [
    "date",
    "time",
    "t",
    "timestamp",
    "period",
    "x",
    "day",
    "datetime",
    "month",
]
const PT_VALUE_KEYS = [
    "value",
    "price",
    "close",
    "rate",
    "y",
    "v",
    "last",
    "settle",
    "avg",
    "average",
    "mean",
    "clean",
    "kwhperm2",
    "kwh",
]
const SKIP_NUM =
    /change|chg|pct|percent|delta|year|date|time|lat|lon|^id$|rank|decimals|digits|precision/

function toSeries(v: any): number[] | undefined {
    if (!Array.isArray(v) || v.length < 3) return undefined
    const out = v
        .map((x) =>
            typeof x === "object" && x ? pickNum(lc(x), PT_VALUE_KEYS) : num(x)
        )
        .filter((x): x is number => x !== null)
    return out.length >= 3 ? out : undefined
}

function shortDate(v: any): string | undefined {
    if (typeof v !== "string") return undefined
    return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v.slice(0, 16)
}

/* ---- dated points (history) ---- */

type Pt = { d: any; v: number }

const toDate = (d: any): number | null => {
    if (d == null) return null
    if (typeof d === "number") return d < 1e11 ? d * 1000 : d
    const t = Date.parse(String(d))
    return isNaN(t) ? null : t
}

function toPts(v: any): Pt[] {
    let out: Pt[] = []
    if (Array.isArray(v)) {
        out = v
            .map((x) => {
                if (isNum(x) || (typeof x === "string" && num(x) !== null))
                    return { d: null, v: num(x) }
                if (Array.isArray(x)) return { d: x[0], v: num(x[1]) }
                if (x && typeof x === "object") {
                    const o = lc(x)
                    return {
                        d: pickKey(o, DATE_KEYS) ?? null,
                        v: pickNum(o, PT_VALUE_KEYS),
                    }
                }
                return { d: null, v: null }
            })
            .filter((p) => p.v !== null) as Pt[]
    } else if (v && typeof v === "object") {
        const o = lc(v)
        const xs = pickKey(o, ["dates", "labels", "x", "t", "times"])
        const ys = pickKey(o, ["values", "y", "prices", "data", "rates"])
        if (Array.isArray(xs) && Array.isArray(ys) && xs.length === ys.length) {
            out = xs
                .map((d, i) => ({ d, v: num(ys[i]) }))
                .filter((p) => p.v !== null) as Pt[]
        } else {
            for (const k of [
                ...SERIES_KEYS,
                "days",
                "data",
                "observations",
                "timeseries",
                "chart",
                "rates",
            ]) {
                if (Array.isArray(o[k])) {
                    const r = toPts(o[k])
                    if (r.length > 2) return r
                }
            }
            const e = Object.entries(v).filter(
                ([k, x]) => isNum(x) && !isNaN(Date.parse(k))
            )
            if (e.length > 2)
                out = e
                    .map(([k, x]) => ({ d: k, v: x as number }))
                    .sort((a, b) => Date.parse(a.d) - Date.parse(b.d))
        }
    }
    const a = toDate(out[0]?.d)
    const b = toDate(out[out.length - 1]?.d)
    if (a !== null && b !== null && a > b) out.reverse()
    return out
}

function toRow([key, item]: [string, any]): Row | null {
    if (isNum(item)) return { label: key, value: item, change: null, pct: null }
    if (!item || typeof item !== "object") return null
    let o = lc(item)
    for (const nest of ["latest", "current", "last"]) {
        if (o[nest] && typeof o[nest] === "object" && !Array.isArray(o[nest]))
            o = { ...o, ...lc(o[nest]) }
    }
    let label = pickKey(o, LABEL_KEYS)
    if (typeof label !== "string")
        label = isNaN(Number(key)) ? key : "Series " + (Number(key) + 1)

    // dated points nested in the item (series / points / days / data ...)
    let pts: Pt[] = []
    for (const k of [...SERIES_KEYS, "days", "data", "observations"]) {
        if (Array.isArray(o[k]) && o[k].length > 1) {
            const r = toPts(o[k])
            if (r.length > 1) {
                pts = r
                break
            }
        }
    }

    // last point wins, then flat fields, then any stray number
    let value: number | null = pts.length ? pts[pts.length - 1].v : null
    if (value === null) value = pickNum(o, VALUE_KEYS)
    if (value === null) {
        for (const k of Object.keys(o)) {
            if (SKIP_NUM.test(k)) continue
            if (isNum(o[k])) {
                value = o[k]
                break
            }
        }
    }
    let change = pickNum(o, CHANGE_KEYS)
    if (change === null && pts.length > 1)
        change = pts[pts.length - 1].v - pts[pts.length - 2].v
    let pct = pickNum(o, PCT_KEYS)
    if (
        pct === null &&
        change !== null &&
        value !== null &&
        value - change !== 0
    )
        pct = (change / (value - change)) * 100

    let series: number[] | undefined =
        pts.length > 2 ? pts.map((p) => p.v) : undefined
    if (!series)
        for (const k of SERIES_KEYS) {
            series = toSeries(o[k])
            if (series) break
        }
    const unitRaw = pickKey(o, ["unit", "units", "currency", "uom"])
    return {
        label: String(label),
        value,
        change,
        pct,
        unit: typeof unitRaw === "string" ? unitRaw : undefined,
        sub:
            shortDate(
                pickKey(o, [
                    "date",
                    "period",
                    "asof",
                    "updated",
                    "week",
                    "month",
                    "timestamp",
                ])
            ) || (pts.length ? shortDate(pts[pts.length - 1].d) : undefined),
        series,
    }
}

const rowsOf = (d: any): Row[] =>
    collect(d)
        .map(toRow)
        .filter((r): r is Row => !!r && r.value !== null)

function fdate(v: any, withTime = false): string {
    if (!v) return ""
    const d = new Date(v)
    if (isNaN(d.getTime())) return String(v).slice(0, 16)
    return d.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    })
}

const decs = (n: number) =>
    Math.abs(n) >= 10000 ? 0 : Math.abs(n) >= 1 ? 2 : 4
const nf = (n: number, d?: number) =>
    n.toLocaleString("en-US", {
        minimumFractionDigits: d ?? decs(n),
        maximumFractionDigits: d ?? decs(n),
    })
const signed = (n: number, d?: number) =>
    (n > 0 ? "+" : n < 0 ? "−" : "") + nf(Math.abs(n), d)
const dir = (n: number | null) =>
    n === null || n === 0 ? "" : n > 0 ? "up" : "dn"
const pretty = (s: string) => {
    const t = s
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-.]+/g, " ")
        .trim()
    return t.charAt(0).toUpperCase() + t.slice(1)
}

function sliceRange(pts: Pt[], days: number): Pt[] {
    if (pts.length < 3) return pts
    const last = toDate(pts[pts.length - 1].d)
    if (last !== null && toDate(pts[0].d) !== null) {
        const c = last - days * 864e5
        const r = pts.filter((p) => {
            const t = toDate(p.d)
            return t !== null && t >= c
        })
        return r.length >= 2 ? r : pts.slice(-2)
    }
    return pts.slice(-Math.max(2, Math.round((pts.length * days) / 366)))
}

function thin(pts: Pt[], n: number): Pt[] {
    if (pts.length <= n) return pts
    const out: Pt[] = []
    for (let i = 0; i < n; i++)
        out.push(pts[Math.round((i * (pts.length - 1)) / (n - 1))])
    return out
}

function pctBack(pts: Pt[], days: number, idx: number): number | null {
    if (pts.length < 2) return null
    const last = pts[pts.length - 1]
    const lt = toDate(last.d)
    let ref: Pt | undefined
    if (lt !== null) {
        for (let i = pts.length - 2; i >= 0; i--) {
            const t = toDate(pts[i].d)
            if (t !== null && t <= lt - days * 864e5) {
                ref = pts[i]
                break
            }
        }
        if (!ref && days > 0) ref = undefined
    } else ref = pts[Math.max(0, pts.length - 1 - idx)]
    if (!ref || ref.v === 0) return null
    return ((last.v - ref.v) / ref.v) * 100
}

/* ---- country identity + generic tree walking ---- */

type Country = { iso3: string; iso2?: string; name: string }

const strip = (s: string) =>
    s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z]/g, "")
const ALIAS_GROUPS = [
    ["unitedstates", "unitedstatesofamerica", "usa", "us"],
    ["russia", "russianfederation"],
    ["southkorea", "korearep", "republicofkorea", "korea"],
    ["iran", "iranislamicrep", "iranislamicrepublicof"],
    ["egypt", "egyptarabrep"],
    ["turkey", "turkiye"],
    ["czechia", "czechrepublic"],
    [
        "drcongo",
        "demrepcongo",
        "congodemrep",
        "democraticrepublicofthecongo",
        "congodemocraticrepublic",
    ],
    ["congo", "congorep", "republicofthecongo"],
    ["laos", "laopdr", "laopeoplesdemocraticrepublic"],
    ["venezuela", "venezuelarb"],
    ["yemen", "yemenrep"],
    ["kyrgyzstan", "kyrgyzrepublic"],
    ["slovakia", "slovakrepublic"],
    ["gambia", "thegambia", "gambiathe"],
    ["bahamas", "thebahamas", "bahamasthe"],
    ["ivorycoast", "cotedivoire"],
    ["centralafricanrepublic", "centralafricanrep"],
    ["dominicanrepublic", "dominicanrep"],
    ["eswatini", "swaziland"],
    ["northmacedonia", "macedonia"],
    ["myanmar", "burma"],
    ["bosniaandherzegovina", "bosniaandherz"],
    ["equatorialguinea", "eqguinea"],
    ["southsudan", "ssudan"],
    ["solomonislands", "solomonis"],
    ["timorleste", "easttimor"],
    ["brunei", "bruneidarussalam"],
    ["syria", "syrianarabrepublic"],
    ["vietnam", "vietnam"],
    ["palestine", "westbankandgaza"],
    ["hongkong", "hongkongsarchina"],
    ["micronesia", "micronesiafedsts"],
]
const ALIAS = new Map<string, string>()
ALIAS_GROUPS.forEach((g) => g.forEach((a) => ALIAS.set(a, g[0])))
const canon = (s: string) => {
    const k = strip(s)
    return ALIAS.get(k) || k
}

const ID_KEYS = [
    "iso3",
    "iso_code",
    "isocode",
    "iso3code",
    "countrycode",
    "country_code",
    "alpha3",
    "code",
    "iso",
    "id",
]
const NAME_KEYS = [
    "country",
    "countryname",
    "country_name",
    "name",
    "entity",
    "economy",
    "location",
    "area",
]
const sv = (v: any): string | undefined =>
    typeof v === "string"
        ? v
        : v && typeof v === "object" && typeof (v.value || v.name) === "string"
          ? v.value || v.name
          : undefined

function idOf(o: Record<string, any>, hint?: string) {
    let iso: string | undefined
    let name: string | undefined
    for (const k of ID_KEYS) {
        const v = sv(o[k])
        if (v && /^[A-Za-z]{2,3}$/.test(v.trim())) {
            iso = v.trim().toUpperCase()
            break
        }
    }
    for (const k of NAME_KEYS) {
        const v = sv(o[k])
        if (v) {
            name = v
            break
        }
    }
    if (hint) {
        if (/^[A-Za-z]{3}$/.test(hint)) iso = iso || hint.toUpperCase()
        else if (isNaN(Number(hint))) name = name || hint
    }
    return { iso, name }
}
const sameCountry = (c: Country, id: { iso?: string; name?: string }) =>
    !!(
        (id.iso && (id.iso === c.iso3 || id.iso === c.iso2)) ||
        (id.name && canon(id.name) === canon(c.name))
    )

type Visit = (
    item: any,
    path: string[],
    sibs: any[] | null,
    hint?: string
) => void
function walk(d: any, cb: Visit, path: string[] = [], depth = 0) {
    if (depth > 6 || d == null || typeof d !== "object") return
    if (Array.isArray(d)) {
        const objs = d.filter(
            (x) => x && typeof x === "object" && !Array.isArray(x)
        )
        objs.forEach((x) => {
            cb(x, path, objs, undefined)
            walk(x, cb, path, depth + 1)
        })
        return
    }
    Object.entries(d).forEach(([k, v]) => {
        if (v && typeof v === "object") {
            if (!Array.isArray(v)) cb(v, path, null, k)
            walk(v, cb, [...path, k], depth + 1)
        }
    })
}

/* ---- ISO table for the map (numeric id, iso3, iso2) ---- */

const ISO_RAW =
    "048 BHR BH|052 BRB BB|132 CPV CV|174 COM KM|212 DMA DM|308 GRD GD|662 LCA LC|670 VCT VC|659 KNA KN|028 ATG AG|470 MLT MT|480 MUS MU|462 MDV MV|702 SGP SG|690 SYC SC|678 STP ST|882 WSM WS|776 TON TO|296 KIR KI|584 MHL MH|583 FSM FM|585 PLW PW|520 NRU NR|798 TUV TV|438 LIE LI|020 AND AD|492 MCO MC|674 SMR SM|336 VAT VA|344 HKG HK|446 MAC MO|533 ABW AW|531 CUW CW|850 VIR VI|092 VGB VG|136 CYM KY|500 MSR MS|660 AIA AI|796 TCA TC|060 BMU BM|254 GUF GF|258 PYF PF|570 NIU NU|184 COK CK|016 ASM AS|316 GUM GU|580 MNP MP|234 FRO FO|833 IMN IM|831 GGY GG|832 JEY JE|238 FLK FK|004 AFG AF|008 ALB AL|012 DZA DZ|024 AGO AO|032 ARG AR|036 AUS AU|040 AUT AT|031 AZE AZ|044 BHS BS|050 BGD BD|051 ARM AM|056 BEL BE|064 BTN BT|068 BOL BO|070 BIH BA|072 BWA BW|076 BRA BR|084 BLZ BZ|090 SLB SB|096 BRN BN|100 BGR BG|104 MMR MM|108 BDI BI|112 BLR BY|116 KHM KH|120 CMR CM|124 CAN CA|140 CAF CF|144 LKA LK|148 TCD TD|152 CHL CL|156 CHN CN|158 TWN TW|170 COL CO|178 COG CG|180 COD CD|188 CRI CR|191 HRV HR|192 CUB CU|196 CYP CY|203 CZE CZ|204 BEN BJ|208 DNK DK|214 DOM DO|218 ECU EC|222 SLV SV|226 GNQ GQ|231 ETH ET|232 ERI ER|233 EST EE|238 FLK FK|242 FJI FJ|246 FIN FI|250 FRA FR|260 ATF TF|262 DJI DJ|266 GAB GA|268 GEO GE|270 GMB GM|275 PSE PS|276 DEU DE|288 GHA GH|300 GRC GR|304 GRL GL|320 GTM GT|324 GIN GN|328 GUY GY|332 HTI HT|340 HND HN|348 HUN HU|352 ISL IS|356 IND IN|360 IDN ID|364 IRN IR|368 IRQ IQ|372 IRL IE|376 ISR IL|380 ITA IT|384 CIV CI|388 JAM JM|392 JPN JP|398 KAZ KZ|400 JOR JO|404 KEN KE|408 PRK KP|410 KOR KR|414 KWT KW|417 KGZ KG|418 LAO LA|422 LBN LB|426 LSO LS|428 LVA LV|430 LBR LR|434 LBY LY|440 LTU LT|442 LUX LU|450 MDG MG|454 MWI MW|458 MYS MY|466 MLI ML|478 MRT MR|484 MEX MX|496 MNG MN|498 MDA MD|499 MNE ME|504 MAR MA|508 MOZ MZ|512 OMN OM|516 NAM NA|524 NPL NP|528 NLD NL|540 NCL NC|548 VUT VU|554 NZL NZ|558 NIC NI|562 NER NE|566 NGA NG|578 NOR NO|586 PAK PK|591 PAN PA|598 PNG PG|600 PRY PY|604 PER PE|608 PHL PH|616 POL PL|620 PRT PT|624 GNB GW|626 TLS TL|630 PRI PR|634 QAT QA|642 ROU RO|643 RUS RU|646 RWA RW|682 SAU SA|686 SEN SN|688 SRB RS|694 SLE SL|703 SVK SK|704 VNM VN|705 SVN SI|706 SOM SO|710 ZAF ZA|716 ZWE ZW|724 ESP ES|728 SSD SS|729 SDN SD|732 ESH EH|740 SUR SR|748 SWZ SZ|752 SWE SE|756 CHE CH|760 SYR SY|762 TJK TJ|764 THA TH|768 TGO TG|780 TTO TT|784 ARE AE|788 TUN TN|792 TUR TR|795 TKM TM|800 UGA UG|804 UKR UA|807 MKD MK|818 EGY EG|826 GBR GB|834 TZA TZ|840 USA US|854 BFA BF|858 URY UY|860 UZB UZ|862 VEN VE|887 YEM YE|894 ZMB ZM"
const ISO_NUM: Record<string, [string, string]> = {}
const ISO_ALL = new Set<string>()
const ISO3_2: Record<string, string> = {}
ISO_RAW.split("|").forEach((s) => {
    const [n, a3, a2] = s.split(" ")
    ISO_NUM[n] = [a3, a2]
    ISO_ALL.add(a3)
    ISO3_2[a3] = a2
})
const NAME_FIX: Record<string, string> = {
    "United States of America": "United States",
    "Dem. Rep. Congo": "DR Congo",
    "Central African Rep.": "Central African Republic",
    "Dominican Rep.": "Dominican Republic",
    "Bosnia and Herz.": "Bosnia and Herzegovina",
    "S. Sudan": "South Sudan",
    "Eq. Guinea": "Equatorial Guinea",
    "Solomon Is.": "Solomon Islands",
    eSwatini: "Eswatini",
    "W. Sahara": "Western Sahara",
    "Falkland Is.": "Falkland Islands",
    "Fr. S. Antarctic Lands": "French Southern Lands",
}
const CURRENCY: Record<string, string> = {
    GBR: "GBP",
    JPN: "JPY",
    CHN: "CNY",
    IND: "INR",
    ZAF: "ZAR",
    BRA: "BRL",
    CAN: "CAD",
    AUS: "AUD",
    KOR: "KRW",
    MEX: "MXN",
    TUR: "TRY",
    NGA: "NGN",
    CHE: "CHF",
    NOR: "NOK",
    SWE: "SEK",
}
"FRA DEU ITA ESP PRT NLD BEL AUT FIN IRL GRC LUX SVK SVN EST LVA LTU CYP MLT HRV"
    .split(" ")
    .forEach((c) => (CURRENCY[c] = "EUR"))
Object.assign(CURRENCY, {
    RUS: "RUB",
    ARE: "AED",
    SAU: "SAR",
    QAT: "QAR",
    KWT: "KWD",
    ISR: "ILS",
    EGY: "EGP",
    MAR: "MAD",
    DZA: "DZD",
    TUN: "TND",
    KEN: "KES",
    ETH: "ETB",
    GHA: "GHS",
    TZA: "TZS",
    UGA: "UGX",
    ZMB: "ZMW",
    AGO: "AOA",
    ARG: "ARS",
    CHL: "CLP",
    COL: "COP",
    PER: "PEN",
    URY: "UYU",
    VEN: "VES",
    IDN: "IDR",
    MYS: "MYR",
    THA: "THB",
    VNM: "VND",
    PHL: "PHP",
    SGP: "SGD",
    HKG: "HKD",
    TWN: "TWD",
    PAK: "PKR",
    BGD: "BDT",
    LKA: "LKR",
    NPL: "NPR",
    KAZ: "KZT",
    UKR: "UAH",
    POL: "PLN",
    CZE: "CZK",
    HUN: "HUF",
    ROU: "RON",
    BGR: "BGN",
    DNK: "DKK",
    ISL: "ISK",
    NZL: "NZD",
    IRQ: "IQD",
    IRN: "IRR",
    JOR: "JOD",
    OMN: "OMR",
    BHR: "BHD",
    LBN: "LBP",
    LBY: "LYD",
    SDN: "SDG",
    COD: "CDF",
    MOZ: "MZN",
    BWA: "BWP",
    NAM: "NAD",
    MUS: "MUR",
    UZB: "UZS",
    AZE: "AZN",
    GEO: "GEL",
    ARM: "AMD",
    MNG: "MNT",
    KHM: "KHR",
    MMR: "MMK",
    BOL: "BOB",
    PRY: "PYG",
    DOM: "DOP",
    CRI: "CRC",
    GTM: "GTQ",
    JAM: "JMD",
    TTO: "TTD",
    SRB: "RSD",
    MDA: "MDL",
    BLR: "BYN",
    ALB: "ALL",
    MKD: "MKD",
    BIH: "BAM",
    TKM: "TMT",
    AFG: "AFN",
    SYR: "SYP",
    YEM: "YER",
    SEN: "XOF",
    CIV: "XOF",
    CMR: "XAF",
    GAB: "XAF",
    COG: "XAF",
})
const AGG =
    /income|world|union|area|region|dividend|\bida\b|ibrd|oecd|small states|fragile|least developed|heavily|countries|asia|africa|europe|america|caribbean|pacific|arab world|total|members|&|sub-/i

/* English country name from ISO3 / ISO2 (falls back to the code) */
let REGION_NAMES: any = null
function regionName(iso: string): string {
    const a2 = iso.length === 2 ? iso : ISO3_2[iso]
    try {
        REGION_NAMES =
            REGION_NAMES ||
            new (Intl as any).DisplayNames(["en"], { type: "region" })
        return (a2 && REGION_NAMES.of(a2)) || iso
    } catch {
        return iso
    }
}

/* ---- TopoJSON -> projected SVG paths (no dependencies) ---- */

type Feat = { iso3: string; iso2?: string; name: string; d: string }
type Geo = { feats: Feat[]; w: number; h: number }

const ne = (lon: number, lat: number): [number, number] => {
    const l = (lon * Math.PI) / 180
    const p = (lat * Math.PI) / 180
    const p2 = p * p
    const p4 = p2 * p2
    return [
        l *
            (0.8707 -
                0.131979 * p2 +
                p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
        p *
            (1.007226 +
                p2 *
                    (0.015085 +
                        p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
    ]
}

// Miller cylindrical projection (the familiar "normal" world map)
const mil = (lon: number, lat: number): [number, number] => [
    (lon * Math.PI) / 180,
    1.25 * Math.log(Math.tan(Math.PI / 4 + (0.4 * lat * Math.PI) / 180)),
]

function buildGeo(topo: any): Geo {
    const obj =
        topo.objects.countries || topo.objects[Object.keys(topo.objects)[0]]
    const { scale, translate } = topo.transform
    const arcs: number[][][] = topo.arcs.map((arc: number[][]) => {
        let x = 0
        let y = 0
        return arc.map(([dx, dy]) => {
            x += dx
            y += dy
            return [x * scale[0] + translate[0], y * scale[1] + translate[1]]
        })
    })
    const ring = (idx: number[]) => {
        let out: number[][] = []
        idx.forEach((i) => {
            const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]
            out = out.concat(out.length ? a.slice(1) : a)
        })
        return out
    }
    // fixed frame = the whole world, Antarctica cropped (lat 84 .. -58)
    const minX = mil(-180, 0)[0]
    const maxX = mil(180, 0)[0]
    const maxY = mil(0, 83.7)[1]
    const minY = mil(0, -56)[1]
    const raw: { id: string; name: string; rings: [number, number][][] }[] = []
    obj.geometries.forEach((g: any) => {
        const id = g.id == null ? "" : String(g.id).padStart(3, "0")
        if (id === "010") return
        const polys: number[][][] = g.type === "Polygon" ? [g.arcs] : g.arcs
        const rings: [number, number][][] = []
        polys.forEach((p: any) =>
            p.forEach((r: number[]) => {
                const pts = ring(r)
                if (!pts.length) return
                // unwrap longitudes so a ring crossing the antimeridian stays continuous
                let shift = 0
                let prev = pts[0][0]
                const un = pts.map(([lo, la]) => {
                    if (lo - prev > 180) shift -= 360
                    else if (lo - prev < -180) shift += 360
                    prev = lo
                    return [lo + shift, la]
                })
                let lo0 = Infinity
                let lo1 = -Infinity
                un.forEach(([lo]) => {
                    if (lo < lo0) lo0 = lo
                    if (lo > lo1) lo1 = lo
                })
                // draw a wrapped copy so the part past +/-180 shows on the other edge
                const offs = [0]
                if (lo1 > 180) offs.push(-360)
                if (lo0 < -180) offs.push(360)
                offs.forEach((o) =>
                    rings.push(un.map(([lo, la]) => mil(lo + o, la)))
                )
            })
        )
        raw.push({ id, name: (g.properties && g.properties.name) || "", rings })
    })
    const k = 1000 / (maxX - minX)
    const feats: Feat[] = raw.map((r) => {
        const d = r.rings
            .map(
                (pr) =>
                    "M" +
                    pr
                        .map(
                            ([x, y]) =>
                                ((x - minX) * k).toFixed(1) +
                                "," +
                                ((maxY - y) * k).toFixed(1)
                        )
                        .join("L") +
                    "Z"
            )
            .join("")
        const iso = ISO_NUM[r.id]
        return {
            iso3: iso ? iso[0] : "",
            iso2: iso ? iso[1] : undefined,
            name: NAME_FIX[r.name] || r.name,
            d,
        }
    })
    return { feats, w: 1000, h: Math.ceil((maxY - minY) * k) }
}

const TOPO_URL =
    "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"

function useGeo(): Geo | null {
    const [g, set] = React.useState<Geo | null>(null)
    React.useEffect(() => {
        let alive = true
        getJSON(TOPO_URL, 864e5)
            .then((t) => alive && set(buildGeo(t)))
            .catch(() => alive && set({ feats: [], w: 1000, h: 500 }))
        return () => {
            alive = false
        }
    }, [])
    return g
}

/* ---- indicator CSVs ---- */

type Obs = {
    iso: string
    name: string
    year: number
    value: number
    unit?: string
    source?: string
    licence?: string
    retrieved?: string
}
type Ind = {
    err?: string
    byIso: Map<
        string,
        {
            name: string
            pts: { y: number; v: number }[]
            unit?: string
            source?: string
            licence?: string
            retrieved?: string
        }
    >
}

function detectSep(t: string): string {
    const head = t.split(/\r?\n/).slice(0, 5).join("\n")
    const count = (ch: string) => head.split(ch).length - 1
    const c = [
        [",", count(",")],
        [";", count(";")],
        ["\t", count("\t")],
    ] as [string, number][]
    c.sort((a, b) => b[1] - a[1])
    return c[0][1] > 0 ? c[0][0] : ","
}

function parseCSV(text: string): string[][] {
    const t = text.replace(/^\uFEFF/, "")
    const sep = detectSep(t)
    const rows: string[][] = []
    let row: string[] = []
    let f = ""
    let q = false
    for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (q) {
            if (c === '"') {
                if (t[i + 1] === '"') {
                    f += '"'
                    i++
                } else q = false
            } else f += c
        } else if (c === '"') q = true
        else if (c === sep) {
            row.push(f)
            f = ""
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && t[i + 1] === "\n") i++
            row.push(f)
            rows.push(row)
            row = []
            f = ""
        } else f += c
    }
    if (f !== "" || row.length) {
        row.push(f)
        rows.push(row)
    }
    return rows
}

// accepts 822.4044, 822,4044, 1 234,5, 1,234.5
function toNum(s: string): number {
    let x = (s || "").replace(/[\s\u00a0]/g, "")
    if (x === "") return NaN
    if (x.includes(",") && x.includes(".")) {
        x =
            x.lastIndexOf(",") > x.lastIndexOf(".")
                ? x.replace(/\./g, "").replace(",", ".")
                : x.replace(/,/g, "")
    } else if (x.includes(",")) {
        x = /^-?\d{1,3}(,\d{3})+$/.test(x)
            ? x.replace(/,/g, "")
            : x.replace(",", ".")
    }
    return Number(x)
}

function parseIndicator(text: string): Obs[] {
    const all = parseCSV(text).filter((r) => r.length > 1)
    // header = first row containing a "value" column (skips an optional title row)
    const hi = all.findIndex((r) => r.some((c) => /^value$/i.test(c.trim())))
    const rows = hi >= 0 ? all.slice(hi) : all
    if (rows.length < 2) return []
    const head = rows[0].map((h) => h.trim().toLowerCase())
    const body = rows.slice(1)
    const sample = body.slice(0, 80)
    const isIso = (j: number) =>
        sample.every((r) => /^[A-Z]{3}$/.test((r[j] || "").trim()))
    let iso = head.findIndex((h) =>
        /^(country_?iso3|countryiso3code|iso3|iso_?code|country_?code|alpha3)$/.test(
            h
        )
    )
    if (iso < 0)
        iso = head.findIndex((h, j) => !/series|indicator/.test(h) && isIso(j))
    const name = head.findIndex(
        (h, j) =>
            j !== iso &&
            /country|economy|entity|^name$|location/.test(h) &&
            !/code|iso/.test(h)
    )
    const year = head.findIndex((h) => /^(year|date|period|time)/.test(h))
    let val = head.findIndex((h) => h === "value")
    if (val < 0)
        val = head.findIndex((h) => /value|obs/.test(h) && !/unit/.test(h))
    if (iso < 0 || year < 0 || val < 0) return []
    const unit = head.findIndex((h) => h === "unit" || h === "units")
    const src = head.findIndex((h) => h === "source")
    const lic = head.findIndex((h) => h === "licence" || h === "license")
    const ret = head.findIndex((h) => /retriev/.test(h))
    const out: Obs[] = []
    body.forEach((r) => {
        const v = toNum(r[val])
        const y = parseInt(r[year], 10)
        if (!isFinite(v) || !isFinite(y) || !r[iso]) return
        out.push({
            iso: r[iso].trim().toUpperCase(),
            name: name >= 0 ? r[name] : r[iso],
            year: y,
            value: v,
            unit: unit >= 0 ? r[unit] : undefined,
            source: src >= 0 ? r[src] : undefined,
            licence: lic >= 0 ? r[lic] : undefined,
            retrieved: ret >= 0 ? r[ret] : undefined,
        })
    })
    return out
}

function buildInd(obs: Obs[]): Ind {
    const byIso: Ind["byIso"] = new Map()
    obs.forEach((o) => {
        let e = byIso.get(o.iso)
        if (!e)
            byIso.set(
                o.iso,
                (e = {
                    name: o.name,
                    pts: [],
                    unit: o.unit,
                    source: o.source,
                    licence: o.licence,
                    retrieved: o.retrieved,
                })
            )
        e.pts.push({ y: o.year, v: o.value })
    })
    byIso.forEach((e) => e.pts.sort((a, b) => a.y - b.y))
    return { byIso }
}

// CSV files live at <CSV_BASE>/data/indicators/<slug>.csv
// Tries uploaded file, CSV base, the API host, /<slug>.csv, then the proxy; first one with rows wins.
let API_BASE = DATA_URL
// Optional CORS proxy, e.g. "https://api.allorigins.win/raw?url={url}" (empty = off)
let CSV_PROXY = ""
// Shows the raw API slice for the selected country under the Country panel
let DEBUG_RAW = false
// CSV files uploaded in Framer (slug -> framerusercontent URL): always CORS-safe
let CSV_FILES: Record<string, string> = {}
const CSV_SLUGS = [
    "electricity-access",
    "renewable-electricity-share",
    "co2-per-capita",
    "power-consumption-per-capita",
    "clean-cooking",
    "gdp-per-capita",
]

async function loadIndicator(slug: string): Promise<Ind> {
    const direct = Array.from(
        new Set([
            `${CSV_BASE}/data/indicators/${slug}.csv`,
            `${API_BASE}/data/indicators/${slug}.csv`,
            `${CSV_BASE}/${slug}.csv`,
        ])
    )
    const urls = [
        ...(CSV_FILES[slug] ? [CSV_FILES[slug]] : []),
        ...direct,
        ...(CSV_PROXY
            ? [CSV_PROXY.replace("{url}", encodeURIComponent(direct[0]))]
            : []),
    ]
    const errs: string[] = []
    for (const u of urls) {
        try {
            const t: string = await getText(u, 3600000)
            const ind = buildInd(parseIndicator(t))
            if (ind.byIso.size) return ind
            errs.push(
                u +
                    " → 0 rows parsed. First line: " +
                    t.split(/\r?\n/)[0].slice(0, 120)
            )
        } catch (e: any) {
            const m = String((e && e.message) || e)
            errs.push(
                u +
                    " → " +
                    (/HTTP/.test(m) ? m : "blocked (CORS) or offline: " + m)
            )
        }
    }
    return { byIso: new Map(), err: errs.join("  |  ") }
}

function useCSV(_base: string, slug: string): Ind | null {
    const [ind, set] = React.useState<Ind | null>(null)
    const key =
        CSV_BASE + "|" + API_BASE + "|" + CSV_PROXY + "|" + CSV_FILES[slug]
    React.useEffect(() => {
        let alive = true
        set(null)
        if (!slug) return
        loadIndicator(slug).then((r) => alive && set(r))
        return () => {
            alive = false
        }
    }, [key, slug])
    return ind
}

const lastOf = (e?: { pts: { y: number; v: number }[] }) =>
    e && e.pts.length ? e.pts[e.pts.length - 1] : undefined

function worldVal(ind: Ind): number | null {
    const w = lastOf(ind.byIso.get("WLD"))
    if (w) return w.v
    let s = 0
    let n = 0
    ind.byIso.forEach((e, iso) => {
        const l = lastOf(e)
        if (l && ISO_ALL.has(iso)) {
            s += l.v
            n++
        }
    })
    return n ? s / n : null
}

/* ---- Ember (mix, clean share, carbon intensity) ---- */

const FUELS: [string, string[], string][] = [
    ["Nuclear", ["nuclear"], "#8E0A14"],
    ["Hydro", ["hydro"], "#E9B9B6"],
    ["Wind", ["wind"], "#EFDCD4"],
    ["Solar", ["solar"], "#D9C09B"],
    ["Gas", ["gas"], "#A99774"],
    ["Other fossil", ["otherfossil", "oil"], "#8A7A66"],
    ["Bioenergy", ["bioenergy", "biomass"], "#C7B8A8"],
    ["Coal", ["coal"], "#5A4B42"],
]

function flatNums(
    o: Record<string, any>,
    out: Record<string, number> = {},
    depth = 0
) {
    Object.keys(o).forEach((k) => {
        const v = o[k]
        const n = isNum(v) ? v : null
        if (n !== null) {
            if (out[k] === undefined) out[k] = n
        } else if (Array.isArray(v) && depth < 2) {
            v.forEach((x) => {
                if (x && typeof x === "object") {
                    const xo = lc(x)
                    const lab = sv(
                        pickKey(xo, [
                            "source",
                            "fuel",
                            "variable",
                            "name",
                            "type",
                            "label",
                        ])
                    )
                    const val = pickNum(xo, [
                        "share",
                        "pct",
                        "percent",
                        "value",
                        "twh",
                        "generation",
                    ])
                    if (
                        lab &&
                        val !== null &&
                        out[lab.toLowerCase()] === undefined
                    )
                        out[lab.toLowerCase()] = val
                }
            })
        } else if (v && typeof v === "object" && depth < 2)
            flatNums(lc(v), out, depth + 1)
    })
    return out
}

type Mix = {
    clean: number | null
    carbon: number | null
    total: number | null
    year?: string
    monthEnd?: string
    shares: { name: string; pct: number; color: string }[]
    monthly?: number[]
}

function emberStats(o: Record<string, any>): Mix | null {
    const f = flatNums(o)
    const keys = Object.keys(f)
    const shares: Mix["shares"] = []
    const tw: { name: string; v: number; color: string }[] = []
    FUELS.forEach(([name, ks, color]) => {
        let s: number | undefined
        let t: number | undefined
        keys.forEach((fk) => {
            const n = fk.toLowerCase().replace(/[^a-z]/g, "")
            if (ks.some((k) => n.startsWith(k))) {
                if (/share|pct|percent/.test(fk.toLowerCase())) s = s ?? f[fk]
                else t = t ?? f[fk]
            }
        })
        if (s !== undefined) shares.push({ name, pct: s, color })
        else if (t !== undefined) tw.push({ name, v: t, color })
    })
    if (!shares.length && tw.length) {
        const tot = tw.reduce((a, b) => a + b.v, 0) || 1
        tw.forEach((t) =>
            shares.push({
                name: t.name,
                pct: (t.v / tot) * 100,
                color: t.color,
            })
        )
    }
    const kc = keys.find(
        (k) =>
            /clean|lowcarbon|low_carbon/i.test(k) &&
            /share|pct|percent|clean/i.test(k)
    )
    const kg = keys.find((k) => /carbon|intensity|gco2/i.test(k))
    const kt = keys.find(
        (k) =>
            /(^|_)(total|generation|twh)/i.test(k) &&
            !/share|pct|percent|clean|carbon/i.test(k)
    )
    let clean = kc ? f[kc] : null
    if (clean === null && shares.length) {
        const c = shares
            .filter((s) =>
                ["Nuclear", "Hydro", "Wind", "Solar", "Bioenergy"].includes(
                    s.name
                )
            )
            .reduce((a, b) => a + b.pct, 0)
        clean = c
    }
    const carbon = kg ? f[kg] : null
    if (clean === null && carbon === null && !shares.length) return null
    let monthly: number[] | undefined
    for (const k of [
        "monthly",
        "clean_share_monthly",
        "cleanshare_monthly",
        "months",
        "monthlyclean",
    ]) {
        monthly = toSeries(o[k])
        if (monthly) break
    }
    return {
        clean,
        carbon,
        total: kt ? f[kt] : null,
        year:
            o.year != null
                ? String(o.year)
                : o.period != null
                  ? String(o.period).slice(0, 7)
                  : undefined,
        shares: shares.sort((a, b) => b.pct - a.pct),
        monthly,
    }
}

/* ------------------------------------------------------------------ */
/* Panel registry                                                      */
/* ------------------------------------------------------------------ */

type Kind = "quotes" | "multi" | "fx" | "power" | "bars" | "news" | "events"
type Def = {
    id: string
    code: string
    title: string
    path: string
    kind: Kind
    tags: string[]
    wide?: boolean
    licensed?: boolean
}

const PANELS: Def[] = [
    {
        id: "crude",
        code: "CRD",
        title: "Energy benchmarks",
        path: "/api/v1/crude.json",
        kind: "quotes",
        tags: ["oil", "markets"],
    },
    {
        id: "fx",
        code: "FX",
        title: "Currencies",
        path: "/api/v1/fx.json",
        kind: "fx",
        tags: ["markets"],
    },
    {
        id: "pwr",
        code: "PWR",
        title: "European power, day-ahead",
        path: "/api/v1/entsoe.json",
        kind: "power",
        tags: ["overview", "power"],
        wide: true,
    },
    {
        id: "fred",
        code: "CMD",
        title: "Gas, coal, uranium and metals",
        path: "/api/v1/fred.json",
        kind: "quotes",
        tags: ["overview", "markets", "renewables"],
    },
    {
        id: "eq",
        code: "EQY",
        title: "Energy equities",
        path: "/api/v1/equities.json",
        kind: "quotes",
        tags: ["overview", "oil", "markets"],
        licensed: true,
    },
    {
        id: "news",
        code: "NWS",
        title: "Newsroom",
        path: "/api/v1/news.json",
        kind: "news",
        tags: ["overview", "news"],
    },
    {
        id: "eia",
        code: "EIA",
        title: "US weekly fundamentals",
        path: "/api/v1/eiaweekly.json",
        kind: "quotes",
        tags: ["oil"],
    },
    {
        id: "fuel",
        code: "PMP",
        title: "Retail fuel prices",
        path: "/api/v1/retailfuel.json",
        kind: "multi",
        tags: ["oil"],
        licensed: true,
    },
    {
        id: "mix",
        code: "MIX",
        title: "Power mix and carbon intensity",
        path: "/api/v1/ember.json",
        kind: "bars",
        tags: ["power", "renewables"],
    },
    {
        id: "sol",
        code: "SOL",
        title: "Solar irradiation forecast",
        path: "/api/v1/solar.json",
        kind: "bars",
        tags: ["renewables", "power"],
    },
    {
        id: "rn",
        code: "SRCH",
        title: "Energy news search",
        path: "/api/v1/rapidnews.json",
        kind: "news",
        tags: ["news"],
        licensed: true,
    },
    {
        id: "evt",
        code: "EVT",
        title: "Events calendar",
        path: "/api/v1/events.json",
        kind: "events",
        tags: ["news"],
    },
]

const TABS = [
    { id: "overview", label: "Overview" },
    { id: "oil", label: "Oil and gas" },
    { id: "power", label: "Power" },
    { id: "renewables", label: "Renewables" },
    { id: "markets", label: "Markets" },
    { id: "news", label: "News and events" },
]

/* ------------------------------------------------------------------ */
/* Small views (original panels)                                       */
/* ------------------------------------------------------------------ */

function Spark({ s }: { s: number[] }) {
    const lo = Math.min(...s)
    const hi = Math.max(...s)
    const span = hi - lo || 1
    const pts = s
        .map(
            (v, i) =>
                `${(i / (s.length - 1)) * 60},${16 - ((v - lo) / span) * 14}`
        )
        .join(" ")
    return (
        <svg className="cet-spark" viewBox="0 0 60 18" aria-hidden="true">
            <polyline
                points={pts}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
            />
        </svg>
    )
}

function Heat({ s }: { s: number[] }) {
    const lo = Math.min(...s)
    const hi = Math.max(...s)
    const span = hi - lo || 1
    return (
        <span
            className="cet-heat"
            role="img"
            aria-label={`Range ${nf(lo, 0)} to ${nf(hi, 0)}`}
        >
            {s.map((v, i) => (
                <i
                    key={i}
                    title={nf(v, 1)}
                    style={{ opacity: 0.14 + 0.86 * ((v - lo) / span) }}
                />
            ))}
        </span>
    )
}

function Empty({ json }: { json: any }) {
    return (
        <div className="cet-empty">
            <p>No data available.</p>
            {DEBUG_RAW && (
                <details>
                    <summary>Show raw response</summary>
                    <pre>
                        {JSON.stringify(json?.data ?? json, null, 1).slice(
                            0,
                            1800
                        )}
                    </pre>
                </details>
            )}
        </div>
    )
}

function Quotes({ rows, limit }: { rows: Row[]; limit: number }) {
    const showChg = rows.some((r) => r.change !== null)
    const showPct = rows.some((r) => r.pct !== null)
    const showSpark = rows.some((r) => r.series)
    return (
        <table className="cet-t">
            <thead>
                <tr>
                    <th />
                    {showSpark && <th className="cet-n">Trend</th>}
                    <th className="cet-n">Last</th>
                    {showChg && <th className="cet-n">Chg</th>}
                    {showPct && <th className="cet-n">%Chg</th>}
                </tr>
            </thead>
            <tbody>
                {rows.slice(0, limit).map((r, i) => (
                    <tr key={i}>
                        <td>
                            {r.label}
                            {(r.unit || r.sub) && (
                                <small>
                                    {[r.unit, r.sub].filter(Boolean).join("  ")}
                                </small>
                            )}
                        </td>
                        {showSpark && (
                            <td className={"cet-n " + dir(r.pct ?? r.change)}>
                                {r.series ? <Spark s={r.series} /> : null}
                            </td>
                        )}
                        <td className="cet-n">{nf(r.value as number)}</td>
                        {showChg && (
                            <td className={"cet-n " + dir(r.change)}>
                                {r.change !== null ? signed(r.change) : ""}
                            </td>
                        )}
                        {showPct && (
                            <td className={"cet-n " + dir(r.pct)}>
                                {r.pct !== null ? signed(r.pct, 2) : ""}
                            </td>
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

const BLOCK_COL = /year|date|time|lat|lon|^id$|rank|code/

function Multi({ data, limit }: { data: any; limit: number }) {
    const items = collect(data)
        .map(([k, v]) => [k, lc(v)] as [string, Record<string, any>])
        .filter(([, v]) => v && typeof v === "object")
    const count: Record<string, number> = {}
    const order: string[] = []
    items.slice(0, 40).forEach(([, o]) => {
        Object.keys(o).forEach((k) => {
            if (isNum(o[k]) && !BLOCK_COL.test(k)) {
                if (!count[k]) order.push(k)
                count[k] = (count[k] || 0) + 1
            }
        })
    })
    const cols = order.sort((a, b) => count[b] - count[a]).slice(0, 3)
    if (!cols.length) return <Empty json={{ data }} />
    return (
        <table className="cet-t">
            <thead>
                <tr>
                    <th />
                    {cols.map((c) => (
                        <th key={c} className="cet-n">
                            {c.replace(/_/g, " ")}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {items.slice(0, limit).map(([k, o], i) => {
                    const l = pickKey(o, LABEL_KEYS)
                    return (
                        <tr key={i}>
                            <td>
                                {typeof l === "string"
                                    ? l
                                    : isNaN(Number(k))
                                      ? k
                                      : "Row " + (i + 1)}
                            </td>
                            {cols.map((c) => (
                                <td key={c} className="cet-n">
                                    {isNum(o[c]) ? nf(o[c]) : ""}
                                </td>
                            ))}
                        </tr>
                    )
                })}
            </tbody>
        </table>
    )
}

function FX({ json }: { json: any }) {
    const u = json?.data?.usd
    if (!u) return <Empty json={json} />
    const pairs: [string, number | undefined][] = [
        ["EUR/USD", u.EUR ? 1 / u.EUR : undefined],
        ["GBP/USD", u.GBP ? 1 / u.GBP : undefined],
        ["USD/JPY", u.JPY],
        ["USD/CHF", u.CHF],
        ["USD/CNY", u.CNY],
        ["USD/CAD", u.CAD],
        ["USD/NOK", u.NOK],
        ["USD/INR", u.INR],
    ]
    return (
        <table className="cet-t">
            <thead>
                <tr>
                    <th />
                    <th className="cet-n">Last</th>
                </tr>
            </thead>
            <tbody>
                {pairs
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                        <tr key={k}>
                            <td>{k}</td>
                            <td className="cet-n">{nf(v as number, 4)}</td>
                        </tr>
                    ))}
            </tbody>
        </table>
    )
}

function Power({ rows, limit }: { rows: Row[]; limit: number }) {
    const list = [...rows]
        .sort((a, b) => (b.value as number) - (a.value as number))
        .slice(0, limit)
    const max = Math.max(...list.map((r) => r.value as number), 1)
    const hi = list[0]
    const lo = list[list.length - 1]
    return (
        <div>
            <div className="cet-range">
                <span>
                    Highest <b>{hi.label}</b>{" "}
                    <em className="dn">{nf(hi.value as number, 1)}</em>
                </span>
                <span>
                    Lowest <b>{lo.label}</b>{" "}
                    <em className="up">{nf(lo.value as number, 1)}</em>
                </span>
                <span className="cet-mute">Trend strip: darker is dearer</span>
            </div>
            <div className="cet-pwr">
                {list.map((r, i) => (
                    <div className="cet-prow" key={i}>
                        <span className="cet-pl">{r.label}</span>
                        {r.series ? (
                            <Heat s={r.series.slice(-24)} />
                        ) : (
                            <span className="cet-bar">
                                <i
                                    style={{
                                        width:
                                            Math.max(
                                                2,
                                                ((r.value as number) / max) *
                                                    100
                                            ) + "%",
                                    }}
                                />
                            </span>
                        )}
                        <span className="cet-pv">
                            {nf(r.value as number, 1)}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function Bars({ rows, limit }: { rows: Row[]; limit: number }) {
    const list = rows.slice(0, limit)
    const max = Math.max(...list.map((r) => Math.abs(r.value as number)), 1)
    return (
        <div className="cet-bars">
            {list.map((r, i) => (
                <div className="cet-brow" key={i}>
                    <span className="cet-bl">{r.label}</span>
                    <span className="cet-bar">
                        <i
                            style={{
                                width:
                                    Math.max(
                                        2,
                                        (Math.abs(r.value as number) / max) *
                                            100
                                    ) + "%",
                            }}
                        />
                    </span>
                    <span className="cet-bv">
                        {nf(r.value as number)}
                        {r.unit ? <small> {r.unit}</small> : null}
                    </span>
                </div>
            ))}
        </div>
    )
}

function News({ data, limit }: { data: any; limit: number }) {
    const items = collect(data)
        .map(([, x]) => {
            const o = lc(x)
            const src = pickKey(o, ["source", "publisher", "outlet", "domain"])
            return {
                title: String(pickKey(o, ["title", "headline", "name"]) ?? ""),
                url: String(pickKey(o, ["url", "link", "href"]) ?? ""),
                source:
                    typeof src === "object" && src
                        ? String((src as any).name || (src as any).title || "")
                        : String(src ?? ""),
                date: pickKey(o, [
                    "publishedat",
                    "pubdate",
                    "date",
                    "published",
                    "datetime",
                    "time",
                ]),
            }
        })
        .filter((n) => n.title)
        .slice(0, limit)
    if (!items.length) return <Empty json={{ data }} />
    return (
        <ul className="cet-news">
            {items.map((n, i) => (
                <li key={i}>
                    {n.url ? (
                        <a
                            href={n.url}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {n.title}
                        </a>
                    ) : (
                        <span>{n.title}</span>
                    )}
                    <small>
                        {[n.source, fdate(n.date)].filter(Boolean).join("   ")}
                    </small>
                </li>
            ))}
        </ul>
    )
}

function eventItems(data: any) {
    return collect(data)
        .map(([, x]) => {
            const o = lc(x)
            const loc = pickKey(o, [
                "location",
                "city",
                "venue",
                "place",
                "country",
            ])
            return {
                title: String(pickKey(o, ["title", "name", "event"]) ?? ""),
                url: String(pickKey(o, ["url", "link", "href"]) ?? ""),
                date: pickKey(o, [
                    "start",
                    "startdate",
                    "start_date",
                    "date",
                    "from",
                ]),
                loc: typeof loc === "string" ? loc : "",
            }
        })
        .filter((n) => n.title)
}

function Events({ data, limit }: { data: any; limit: number }) {
    const items = eventItems(data).slice(0, limit)
    if (!items.length) return <Empty json={{ data }} />
    return (
        <ul className="cet-news cet-evt">
            {items.map((n, i) => (
                <li key={i}>
                    <time>{fdate(n.date)}</time>
                    <span>
                        {n.url ? (
                            <a
                                href={n.url}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {n.title}
                            </a>
                        ) : (
                            n.title
                        )}
                        {n.loc && <small>{n.loc}</small>}
                    </span>
                </li>
            ))}
        </ul>
    )
}

/* today's point in a dated series (first date >= today, else the last one) */
function todayPt(pts: Pt[]): Pt {
    const t = new Date().toISOString().slice(0, 10)
    return (
        pts.find((p) => typeof p.d === "string" && p.d.slice(0, 10) >= t) ||
        pts[pts.length - 1]
    )
}

/* MIX: { mix: { AFG: { year, total, twh: { Coal, Gas, ... } }, ... } } */
function MixList({ data, limit }: { data: any; limit: number }) {
    const list = React.useMemo(() => {
        const out: { iso: string; st: Mix }[] = []
        walk(data, (item, _p, _s, hint) => {
            const o = lc(item)
            const id = idOf(o, hint)
            const iso = id.iso && id.iso.length === 3 ? id.iso : undefined
            if (!iso || !ISO_ALL.has(iso)) return
            const st = emberStats(o)
            if (!st || st.clean === null) return
            if (st.total !== null && st.total < 10) return
            out.push({ iso, st })
        })
        return out.sort((a, b) => (b.st.clean ?? 0) - (a.st.clean ?? 0))
    }, [data])
    if (!list.length) return <Empty json={{ data }} />
    return (
        <div className="cet-bars">
            {list.slice(0, limit * 2).map(({ iso, st }) => (
                <div className="cet-brow" key={iso}>
                    <span className="cet-bl">{iso}</span>
                    <span className="cet-bar">
                        <i
                            style={{
                                width:
                                    Math.max(
                                        2,
                                        Math.min(100, st.clean as number)
                                    ) + "%",
                            }}
                        />
                    </span>
                    <span className="cet-bv">
                        {Math.round(st.clean as number)}% clean
                        <small>
                            {[
                                st.total !== null
                                    ? nf(st.total, 0) + " TWh"
                                    : "",
                                st.carbon !== null
                                    ? Math.round(st.carbon) + " g/kWh"
                                    : "",
                                st.year || "",
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        </small>
                    </span>
                </div>
            ))}
        </div>
    )
}

/* SOL: [ { name: "Abuja", days: [ { date, kwhPerM2, sunshineHours } ] } ] */
type SunRow = { name: string; v: number; sun: number | null }
function solarRows(data: any): SunRow[] {
    return collect(data)
        .map(([k, x]) => {
            const o = lc(x)
            const name = String(
                sv(pickKey(o, ["name", "city", "location"])) ?? k
            )
            const days: Record<string, any>[] = Array.isArray(o.days)
                ? o.days.map(lc)
                : []
            if (!days.length) return null
            const t = new Date().toISOString().slice(0, 10)
            const d =
                days.find((z) => String(z.date).slice(0, 10) >= t) ||
                days[days.length - 1]
            const v = pickNum(d, ["kwhperm2", "kwh", "value"])
            if (v === null) return null
            return {
                name,
                v,
                sun: pickNum(d, ["sunshinehours", "sunshine"]),
            }
        })
        .filter((r): r is SunRow => !!r)
        .sort((a, b) => b.v - a.v)
}

function SolarList({ data, limit }: { data: any; limit: number }) {
    const rows = solarRows(data).slice(0, limit * 2)
    if (!rows.length) return <Empty json={{ data }} />
    const max = Math.max(...rows.map((r) => r.v), 1)
    return (
        <div className="cet-bars">
            {rows.map((r) => (
                <div className="cet-brow" key={r.name}>
                    <span className="cet-bl">{r.name}</span>
                    <span className="cet-bar">
                        <i
                            style={{
                                width: Math.max(2, (r.v / max) * 100) + "%",
                            }}
                        />
                    </span>
                    <span className="cet-bv">
                        {nf(r.v, 1)} kWh/m²
                        {r.sun !== null ? <small> {r.sun} h sun</small> : null}
                    </span>
                </div>
            ))}
        </div>
    )
}

function PanelView({
    def,
    base,
    refreshMs,
    limit,
}: {
    def: Def
    base: string
    refreshMs: number
    limit: number
}) {
    const res = usePanel(base, def.path, refreshMs)
    const src = res.json?.source
    const led =
        res.state === "error"
            ? "bad"
            : res.json && res.json.status && res.json.status !== "live"
              ? "warn"
              : res.json
                ? "ok"
                : "idle"
    const rows = React.useMemo(
        () =>
            res.json && ["quotes", "power", "bars"].includes(def.kind)
                ? rowsOf(res.json.data)
                : [],
        [res.json, def.kind]
    )

    let body: React.ReactNode = null
    if (res.state === "error")
        body = (
            <p className="cet-err" title={def.path + " " + (res.error || "")}>
                Data temporarily unavailable.
            </p>
        )
    else if (!res.json)
        body = <p className="cet-load">Loading {def.title.toLowerCase()}</p>
    else if (def.id === "mix")
        body = <MixList data={res.json.data ?? res.json} limit={limit} />
    else if (def.id === "sol")
        body = <SolarList data={res.json.data ?? res.json} limit={limit} />
    else if (def.kind === "fx") body = <FX json={res.json} />
    else if (def.kind === "multi")
        body = <Multi data={res.json.data} limit={limit} />
    else if (def.kind === "news")
        body = <News data={res.json.data} limit={limit} />
    else if (def.kind === "events")
        body = <Events data={res.json.data} limit={limit} />
    else if (!rows.length) body = <Empty json={res.json} />
    else if (def.kind === "power")
        body = <Power rows={rows} limit={limit * 2} />
    else if (def.kind === "bars") body = <Bars rows={rows} limit={limit * 2} />
    else body = <Quotes rows={rows} limit={limit} />

    return (
        <section
            className={"cet-panel" + (def.wide ? " cet-wide" : "")}
            aria-label={def.title}
            id={"cet-" + def.id}
        >
            <header className="cet-ph">
                <h2>
                    <span className="cet-code">{def.code}</span>
                    {def.title}
                </h2>
                <span className="cet-stamp">
                    <i className={"cet-led " + led} aria-hidden="true" />
                    {res.json?.retrievedAt
                        ? fdate(res.json.retrievedAt, true)
                        : led === "bad"
                          ? "offline"
                          : ""}
                </span>
            </header>
            <div className="cet-body">{body}</div>
            <footer className="cet-pf">
                <span>Source: {src ? src.publisher || src.name : "Economic Bearings"}</span>
            </footer>
        </section>
    )
}

function Ticker({
    base,
    refreshMs,
    label,
    sticky = false,
    autoTop = true,
    manualTop = 0,
}: {
    base: string
    refreshMs: number
    label: string
    sticky?: boolean
    autoTop?: boolean
    manualTop?: number
}) {
    // Sticky placement: sit just under the site's own fixed menu bar,
    // and fade out when the end of the terminal would push it over that menu.
    const box = React.useRef<HTMLDivElement>(null)
    const [top, setTop] = React.useState(manualTop)
    const [gone, setGone] = React.useState(false)
    React.useEffect(() => {
        if (!sticky || typeof window === "undefined") return
        let raf = 0
        const menuBottom = (el: HTMLElement) => {
            const root = el.closest(".cet")
            const vh = window.innerHeight
            let off = 0
            ;[0.08, 0.3, 0.5, 0.7, 0.92].forEach((fx) => {
                const list = document.elementsFromPoint
                    ? document.elementsFromPoint(window.innerWidth * fx, 2)
                    : []
                for (const n of list) {
                    if (root && root.contains(n)) continue
                    let a: Element | null = n
                    while (
                        a &&
                        a !== document.body &&
                        a !== document.documentElement
                    ) {
                        const pos = getComputedStyle(a).position
                        if (pos === "fixed" || pos === "sticky") {
                            const r = a.getBoundingClientRect()
                            if (
                                r.top <= 4 &&
                                r.height > 0 &&
                                r.height < vh * 0.4
                            )
                                off = Math.max(off, r.bottom)
                            break
                        }
                        a = a.parentElement
                    }
                }
            })
            return Math.round(off)
        }
        const measure = () => {
            raf = 0
            const el = box.current
            if (!el) return
            const off = autoTop
                ? menuBottom(el) + Math.max(0, manualTop)
                : Math.max(0, manualTop)
            setTop((t) => (t !== off ? off : t))
            setGone(el.getBoundingClientRect().top < off - 2)
        }
        const on = () => {
            if (!raf) raf = requestAnimationFrame(measure)
        }
        measure()
        const t = setTimeout(measure, 600) // menu may render after us
        window.addEventListener("scroll", on, { passive: true, capture: true })
        window.addEventListener("resize", on)
        return () => {
            clearTimeout(t)
            if (raf) cancelAnimationFrame(raf)
            window.removeEventListener("scroll", on, { capture: true } as any)
            window.removeEventListener("resize", on)
        }
    }, [sticky, autoTop, manualTop])

    const crude = usePanel(base, "/api/v1/crude.json", refreshMs)
    const fred = usePanel(base, "/api/v1/fred.json", refreshMs)
    const fx = usePanel(base, "/api/v1/fx.json", refreshMs)
    const items = React.useMemo(() => {
        const out: { label: string; value: number; pct: number | null }[] = []
        if (crude.json)
            rowsOf(crude.json.data)
                .slice(0, 8)
                .forEach((r) =>
                    out.push({
                        label: r.label,
                        value: r.value as number,
                        pct: r.pct,
                    })
                )
        if (fred.json)
            rowsOf(fred.json.data)
                .slice(0, 6)
                .forEach((r) =>
                    out.push({
                        label: r.label,
                        value: r.value as number,
                        pct: r.pct,
                    })
                )
        const eur = fx.json?.data?.usd?.EUR
        if (eur) out.push({ label: "USD/EUR", value: eur, pct: null })
        return out
    }, [crude.json, fred.json, fx.json])

    const track = items.map((it, i) => (
        <span className="cet-ti" key={i}>
            <b>{it.label}</b>
            <span>{nf(it.value, it.label === "USD/EUR" ? 4 : undefined)}</span>
            {it.pct !== null && (
                <em className={dir(it.pct)}>{signed(it.pct, 2)}%</em>
            )}
        </span>
    ))

    return (
        <div
            ref={box}
            className={
                "cet-tick" +
                (sticky ? " cet-sticky" : "") +
                (sticky && gone ? " cet-gone" : "")
            }
            style={sticky ? { top } : undefined}
            role="marquee"
            aria-label="Energy prices"
        >
            <span className="cet-tl">{label}</span>
            <div className="cet-win">
                {items.length === 0 ? (
                    <span className="cet-ti">Loading market data</span>
                ) : (
                    <div
                        className="cet-track"
                        style={{
                            animationDuration:
                                Math.max(30, items.length * 5) + "s",
                        }}
                    >
                        {track}
                        {track}
                    </div>
                )}
            </div>
        </div>
    )
}

/* ------------------------------------------------------------------ */
/* Dashboard: shared bits                                              */
/* ------------------------------------------------------------------ */

function Src({ json }: { json: any }) {
    const s = json?.source
    if (!s) return null
    return <p className="hx-src">Source: {s.publisher || s.name}</p>
}

function Line({
    pts,
    h = 22,
    area = false,
}: {
    pts: number[]
    h?: number
    area?: boolean
}) {
    if (pts.length < 2) return <div style={{ height: h }} />
    const lo = Math.min(...pts)
    const hi = Math.max(...pts)
    const span = hi - lo || 1
    const W = 200
    const xy = pts.map((v, i) => [
        (i / (pts.length - 1)) * W,
        h - 2 - ((v - lo) / span) * (h - 4),
    ])
    const d = xy
        .map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1))
        .join("")
    return (
        <svg
            className="hx-line"
            viewBox={`0 0 ${W} ${h}`}
            preserveAspectRatio="none"
            style={{ height: h }}
            aria-hidden="true"
        >
            {area && (
                <path
                    d={d + `L${W},${h}L0,${h}Z`}
                    fill="currentColor"
                    opacity="0.12"
                />
            )}
            <path
                d={d}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    )
}

/* ------------------------------------------------------------------ */
/* Benchmarks                                                          */
/* ------------------------------------------------------------------ */

const BENCH = [
    { id: "brent", label: "Brent", k: ["brent"] },
    { id: "wti", label: "WTI", k: ["wti"] },
    { id: "hh", label: "Henry Hub gas", k: ["henry", "natural gas"] },
    { id: "gas", label: "Gasoline", k: ["gasoline"] },
    { id: "dsl", label: "Diesel", k: ["diesel"] },
    { id: "jet", label: "Jet fuel", k: ["jet"] },
    { id: "ho", label: "Heating oil", k: ["heating"] },
    { id: "prop", label: "Propane", k: ["propane"] },
]
const RANGES: [string, number][] = [
    ["1M", 30],
    ["3M", 91],
    ["6M", 182],
    ["1Y", 366],
]

const MONTHS3 = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
]

function xTicks(pts: Pt[], days: number) {
    const n = pts.length
    const ds = pts.map((p) => toDate(p.d))
    const out: { i: number; l: string }[] = []
    if (n < 3 || ds.some((x) => x === null)) return out
    if (days > 100) {
        let pm = -1
        ds.forEach((t, i) => {
            const dt = new Date(t as number)
            const m = dt.getUTCFullYear() * 12 + dt.getUTCMonth()
            if (m !== pm) {
                pm = m
                const prev = out[out.length - 1]
                if (!prev || (i - prev.i) / n > 0.05)
                    out.push({
                        i,
                        l: MONTHS3[dt.getUTCMonth()],
                    })
            }
        })
    } else {
        for (let k = 0; k < 5; k++) {
            const i = Math.round((k * (n - 1)) / 4)
            out.push({
                i,
                l: new Date(ds[i] as number).toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                }),
            })
        }
    }
    return out
}

function AreaChart({
    pts,
    days,
    unit,
}: {
    pts: Pt[]
    days: number
    unit: string
}) {
    const [h, setH] = React.useState<number | null>(null)
    const n = pts.length
    const vs = pts.map((p) => p.v)
    const rawLo = Math.min(...vs)
    const rawHi = Math.max(...vs)
    const pad = (rawHi - rawLo || 1) * 0.1
    const lo = rawLo - pad
    const hi = rawHi + pad
    const W = 1000
    const H = 260
    const X = (i: number) => (i / (n - 1)) * W
    const Y = (v: number) => H - ((v - lo) / (hi - lo)) * H
    const line = pts
        .map(
            (p, i) =>
                (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.v).toFixed(1)
        )
        .join("")
    const ticks = [0, 1, 2, 3, 4].map((k) => hi - (k * (hi - lo)) / 4)
    const xt = xTicks(pts, days)
    const hp = h !== null ? pts[h] : null
    return (
        <div className="hx-chartwrap">
            <div
                className="hx-chart"
                onMouseMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setH(
                        Math.max(
                            0,
                            Math.min(
                                n - 1,
                                Math.round(
                                    ((e.clientX - r.left) / r.width) * (n - 1)
                                )
                            )
                        )
                    )
                }}
                onMouseLeave={() => setH(null)}
            >
                <svg
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    aria-label="Price history"
                    role="img"
                >
                    {ticks.map((t, i) => (
                        <line
                            key={i}
                            x1="0"
                            x2={W}
                            y1={Y(t)}
                            y2={Y(t)}
                            stroke="var(--rule)"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                            opacity="0.7"
                        />
                    ))}
                    <path
                        d={line + `L${W},${H}L0,${H}Z`}
                        fill="var(--acc)"
                        opacity="0.13"
                    />
                    <path
                        d={line}
                        fill="none"
                        stroke="var(--acc)"
                        strokeWidth="1.8"
                        vectorEffect="non-scaling-stroke"
                    />
                    {h !== null && (
                        <line
                            x1={X(h)}
                            x2={X(h)}
                            y1="0"
                            y2={H}
                            stroke="var(--ink)"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                            opacity="0.4"
                        />
                    )}
                </svg>
                {hp && h !== null && (
                    <div
                        className="hx-tip"
                        style={{
                            left: (h / (n - 1)) * 100 + "%",
                            transform: `translateX(${h > n * 0.7 ? "-105%" : "8px"})`,
                        }}
                    >
                        <b>{nf(hp.v)}</b> {unit}
                        <small>{fdate(hp.d)}</small>
                    </div>
                )}
                <div className="hx-yl">
                    {ticks.map((t, i) => (
                        <span key={i} style={{ top: (i / 4) * 100 + "%" }}>
                            {nf(t, Math.abs(hi) >= 20 ? 2 : 3)}
                        </span>
                    ))}
                </div>
            </div>
            <div className="hx-xl">
                {xt.map((t, i) => (
                    <span
                        key={i}
                        style={{
                            left: (t.i / (n - 1)) * 100 + "%",
                            transform:
                                t.i === 0
                                    ? "none"
                                    : t.i === n - 1
                                      ? "translateX(-100%)"
                                      : "translateX(-50%)",
                        }}
                    >
                        {t.l}
                    </span>
                ))}
            </div>
        </div>
    )
}

function BenchPanel({
    base,
    refreshMs,
    slider = true,
    speed = 8,
}: {
    base: string
    refreshMs: number
    slider?: boolean
    speed?: number
}) {
    const res = usePanel(base, "/api/v1/crude.json", refreshMs)
    const [sel, setSel] = React.useState("brent")
    const [rg, setRg] = React.useState(366)
    const items = React.useMemo(
        () =>
            res.json
                ? collect(res.json.data)
                      .map(([k, x]) => ({
                          key: k,
                          row: toRow([k, x]),
                          pts: toPts(x),
                          hay: (k + " " + JSON.stringify(x)).toLowerCase(),
                      }))
                      .filter((it) => it.row && it.row.value !== null)
                : [],
        [res.json]
    )
    const find = (ks: string[]) =>
        items.find((it) =>
            ks.some((k) =>
                (it.row!.label + " " + it.key).toLowerCase().includes(k)
            )
        ) ||
        items.find((it) => ks.some((k) => it.hay.slice(0, 400).includes(k)))
    // Auto-rotate: move to the next benchmark that has data, like clicking the next button
    const [paused, setPaused] = React.useState(false)
    const [run, setRun] = React.useState(0)
    const avail = BENCH.filter((b) => !!find(b.k)).map((b) => b.id)
    const auto = slider && avail.length > 1
    const secs = Math.max(2, speed || 8)
    React.useEffect(() => {
        if (!auto || paused) return
        const t = setTimeout(() => {
            const i = avail.indexOf(sel)
            setSel(avail[(i + 1) % avail.length])
        }, secs * 1000)
        return () => clearTimeout(t)
    }, [auto, paused, sel, run, secs, avail.join("|")])
    const pause = () => setPaused(true)
    const resume = () => {
        setPaused(false)
        setRun((r) => r + 1)
    }

    const def = BENCH.find((b) => b.id === sel) || BENCH[0]
    const it = find(def.k)
    const pts = it ? sliceRange(it.pts, rg) : []
    const row = it?.row
    const price = pts.length ? pts[pts.length - 1].v : (row?.value ?? null)
    let chg = row?.change ?? null
    let pct = row?.pct ?? null
    if (chg === null && it && it.pts.length > 1) {
        chg = it.pts[it.pts.length - 1].v - it.pts[it.pts.length - 2].v
        pct = (chg / it.pts[it.pts.length - 2].v) * 100
    }
    const over =
        pts.length > 1 && pts[0].v
            ? ((pts[pts.length - 1].v - pts[0].v) / pts[0].v) * 100
            : null
    const unit = row?.unit || ""

    return (
        <section
            className="hx-card hx-bench"
            aria-label="Energy benchmarks"
            onMouseEnter={pause}
            onMouseLeave={resume}
            onFocusCapture={pause}
            onBlurCapture={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) resume()
            }}
            onPointerDown={(e) => {
                if (e.pointerType !== "mouse") pause()
            }}
        >
            <div className="hx-h">
                <h2 className="hx-t">Energy Benchmarks</h2>
                <div className="hx-pills" role="group" aria-label="Benchmark">
                    {BENCH.map((b) => (
                        <button
                            key={b.id}
                            className="hx-pill"
                            aria-pressed={sel === b.id}
                            onClick={() => setSel(b.id)}
                        >
                            {b.label}
                            {auto && sel === b.id ? (
                                <i
                                    key={sel + ":" + run}
                                    className="hx-prog"
                                    aria-hidden="true"
                                    style={{
                                        animationDuration: secs + "s",
                                        animationPlayState: paused
                                            ? "paused"
                                            : "running",
                                    }}
                                />
                            ) : null}
                        </button>
                    ))}
                </div>
                <div
                    className="hx-pills hx-right"
                    role="group"
                    aria-label="Range"
                >
                    {RANGES.map(([l, d]) => (
                        <button
                            key={l}
                            className="hx-pill"
                            aria-pressed={rg === d}
                            onClick={() => setRg(d)}
                        >
                            {l}
                        </button>
                    ))}
                </div>
            </div>
            {res.state === "error" ? (
                <p className="cet-err" title={res.error}>
                    Data temporarily unavailable.
                </p>
            ) : !res.json ? (
                <p className="cet-load">Loading benchmarks</p>
            ) : !it ? (
                <Empty json={res.json} />
            ) : (
                <>
                    <div className="hx-price">
                        <span className="hx-big">
                            {price !== null ? "$" + nf(price) : "–"}
                        </span>
                        {chg !== null && (
                            <span className={dir(chg)}>
                                {signed(chg)}
                                {pct !== null ? ` (${signed(pct, 2)}%)` : ""}
                            </span>
                        )}
                        {over !== null && (
                            <span>
                                <b className={dir(over)}>{signed(over, 2)}%</b>{" "}
                                over range
                            </span>
                        )}
                    </div>
                    {pts.length > 2 ? (
                        <AreaChart pts={pts} days={rg} unit={unit} />
                    ) : (
                        <p className="cet-load">
                            No history available for this benchmark.
                        </p>
                    )}
                </>
            )}
            <Src json={res.json} />
        </section>
    )
}

/* ------------------------------------------------------------------ */
/* FX watchlist                                                        */
/* ------------------------------------------------------------------ */

function fxSeries(data: any, code: string): Pt[] {
    const want = [
        code,
        "usd" + code,
        "usd/" + code,
        "usd_" + code,
        "usd-" + code,
    ].map((s) => s.toLowerCase())
    const c = code.toLowerCase()
    let found: any
    const visit = (d: any, depth: number) => {
        if (found || d == null || typeof d !== "object" || depth > 5) return
        if (!Array.isArray(d)) {
            for (const k of Object.keys(d)) {
                if (
                    want.includes(k.toLowerCase()) &&
                    d[k] &&
                    typeof d[k] === "object"
                ) {
                    found = d[k]
                    return
                }
            }
            Object.keys(d).forEach((k) => visit(d[k], depth + 1))
        } else {
            const rows = d.filter(
                (x) => x && typeof x === "object" && !Array.isArray(x)
            )
            if (rows.length > 3 && lc(rows[0])[c] !== undefined) {
                found = rows
                    .map((r) => ({
                        d: pickKey(lc(r), DATE_KEYS),
                        v: num(lc(r)[c]),
                    }))
                    .filter((p) => p.v !== null)
                return
            }
            for (const x of rows) {
                const lab = sv(
                    pickKey(lc(x), [
                        "pair",
                        "code",
                        "currency",
                        "symbol",
                        "name",
                        "label",
                        "quote",
                    ])
                )
                if (
                    lab &&
                    want.includes(lab.toLowerCase().replace(/\s/g, ""))
                ) {
                    found = x
                    return
                }
            }
            rows.slice(0, 40).forEach((x) => visit(x, depth + 1))
        }
    }
    visit(data, 0)
    return found ? toPts(found) : []
}

const FX_LIST = ["EUR", "GBP", "JPY", "CNY", "INR", "ZAR", "BRL"]

function FxPanel({ base, refreshMs }: { base: string; refreshMs: number }) {
    const fx = usePanel(base, "/api/v1/fx.json", refreshMs)
    const hist = usePanel(base, "/api/v1/fxhist.json", refreshMs * 6)
    const u = fx.json?.data?.usd
    const rows = React.useMemo(
        () =>
            FX_LIST.map((c) => {
                const h = hist.json
                    ? fxSeries(hist.json.data ?? hist.json, c)
                    : []
                const last =
                    u && u[c] ? u[c] : h.length ? h[h.length - 1].v : null
                return {
                    c,
                    last: last as number | null,
                    d1: pctBack(h, 1, 1),
                    m1: pctBack(h, 30, 21),
                    s: thin(h, 80).map((p) => p.v),
                }
            }),
        [u, hist.json]
    )
    const cell = (v: number | null) =>
        v === null ? (
            <td className="hx-n" />
        ) : (
            <td className={"hx-n " + (Math.abs(v) < 0.005 ? "" : dir(v))}>
                {Math.abs(v) < 0.005 ? "0.00%" : signed(v, 2) + "%"}
            </td>
        )
    return (
        <section className="hx-card hx-fx" aria-label="FX watchlist">
            <div className="hx-h">
                <h2 className="hx-t">FX Watchlist</h2>
                <span className="hx-mute hx-right">per US$ · 1Y</span>
            </div>
            {fx.state === "error" ? (
                <p className="cet-err" title={fx.error}>
                    Data temporarily unavailable.
                </p>
            ) : !u ? (
                <p className="cet-load">Loading currencies</p>
            ) : (
                <table className="hx-tbl">
                    <thead>
                        <tr>
                            <th>Pair</th>
                            <th className="hx-n">Last</th>
                            <th className="hx-n">1D</th>
                            <th className="hx-n">1M</th>
                            <th className="hx-n">12M</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.c}>
                                <td>
                                    <b>USD/{r.c}</b>
                                </td>
                                <td className="hx-n">
                                    {r.last !== null
                                        ? nf(
                                              r.last,
                                              r.last >= 100
                                                  ? 2
                                                  : r.last >= 10
                                                    ? 2
                                                    : 4
                                          )
                                        : ""}
                                </td>
                                {cell(r.d1)}
                                {cell(r.m1)}
                                <td className="hx-n hx-sp">
                                    {r.s.length > 2 ? (
                                        <Line pts={r.s} h={20} />
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <Src json={fx.json} />
        </section>
    )
}

/* ------------------------------------------------------------------ */
/* World map + rankings                                                */
/* ------------------------------------------------------------------ */

type Metric = {
    id: string
    label: string
    slug?: string
    field?: "clean" | "carbon"
    fmt: (v: number) => string
    bins: number[]
    lowDark?: boolean
}
const pc = (v: number) => nf(v, 1) + "%"
const METRICS: Metric[] = [
    {
        id: "access",
        label: "Electricity access",
        slug: "electricity-access",
        fmt: pc,
        bins: [20, 40, 60, 80],
        lowDark: true,
    },
    {
        id: "renew",
        label: "Renewable power",
        slug: "renewable-electricity-share",
        fmt: pc,
        bins: [20, 40, 60, 80],
    },
    {
        id: "co2",
        label: "CO₂ per person",
        slug: "co2-per-capita",
        fmt: (v) => nf(v, 2) + " t",
        bins: [1, 3, 6, 10],
    },
    {
        id: "use",
        label: "Power use per person",
        slug: "power-consumption-per-capita",
        fmt: (v) => nf(v, 0) + " kWh",
        bins: [500, 2000, 5000, 10000],
    },
    {
        id: "cook",
        label: "Clean cooking",
        slug: "clean-cooking",
        fmt: pc,
        bins: [20, 40, 60, 80],
        lowDark: true,
    },
    {
        id: "clean",
        label: "Clean power (Ember)",
        field: "clean",
        fmt: pc,
        bins: [20, 40, 60, 80],
    },
    {
        id: "grid",
        label: "Grid carbon intensity",
        field: "carbon",
        fmt: (v) => nf(v, 0) + " g",
        bins: [100, 250, 400, 600],
    },
]
const SCALE = ["#F1D6CE", "#E6B3A8", "#D4857C", "#B3443F", "#6C0912"]

type Entry = { iso: string; name: string; v: number }

function useEntries(
    base: string,
    m: Metric,
    refreshMs: number,
    nameIso: Map<string, string>
): Entry[] | null {
    const ind = useCSV(base, m.slug || "")
    const ember = usePanel(base, "/api/v1/ember.json", refreshMs * 6)
    return React.useMemo(() => {
        if (m.slug) {
            if (!ind) return null
            const out: Entry[] = []
            ind.byIso.forEach((e, iso) => {
                const l = lastOf(e)
                if (!l) return
                if (!ISO_ALL.has(iso) && AGG.test(e.name)) return
                out.push({ iso, name: e.name, v: l.v })
            })
            const maxY = Math.max(
                ...Array.from(ind.byIso.values()).map((e) => lastOf(e)?.y ?? 0)
            )
            return out.filter((e) => {
                const l = lastOf(ind.byIso.get(e.iso))
                return !!l && l.y >= maxY - 8
            })
        }
        if (!ember.json) return null
        const best = new Map<string, { y: number; e: Entry }>()
        walk(ember.json.data ?? ember.json, (item, _p, _s, hint) => {
            const o = lc(item)
            const id = idOf(o, hint)
            const st = emberStats(o)
            if (!st || (!id.iso && !id.name)) return
            const v = m.field === "clean" ? st.clean : st.carbon
            if (v === null || v === undefined) return
            let iso =
                id.iso && id.iso.length === 3
                    ? id.iso
                    : id.name
                      ? nameIso.get(canon(id.name))
                      : undefined
            if (!iso) return
            const y = parseInt(st.year || "0", 10) || 0
            const prev = best.get(iso)
            if (!prev || y >= prev.y)
                best.set(iso, { y, e: { iso, name: id.name || iso, v } })
        })
        return Array.from(best.values()).map((b) => b.e)
    }, [m, ind, ember.json, nameIso])
}

function WorldPanel({
    geo,
    metric,
    setMetric,
    entries,
    selected,
    onSelect,
    err,
    rotate = true,
    speed = 8,
}: {
    rotate?: boolean
    speed?: number
    geo: Geo | null
    metric: Metric
    setMetric: (id: string) => void
    entries: Entry[] | null
    selected: string
    onSelect: (iso: string) => void
    err?: string
}) {
    const vals = React.useMemo(() => {
        const m = new Map<string, number>()
        entries?.forEach((e) => m.set(e.iso, e.v))
        return m
    }, [entries])
    // Auto-rotate the map metric, like clicking the next button
    const [paused, setPaused] = React.useState(false)
    const [run, setRun] = React.useState(0)
    const secs = Math.max(2, speed || 8)
    React.useEffect(() => {
        if (!rotate || paused) return
        const t = setTimeout(() => {
            const i = METRICS.findIndex((m) => m.id === metric.id)
            setMetric(METRICS[(i + 1) % METRICS.length].id)
        }, secs * 1000)
        return () => clearTimeout(t)
    }, [rotate, paused, metric.id, run, secs])
    const pause = () => setPaused(true)
    const resume = () => {
        setPaused(false)
        setRun((r) => r + 1)
    }

    const wrap = React.useRef<HTMLDivElement>(null)
    const [hov, setHov] = React.useState<string>("")
    const [tip, setTip] = React.useState<{
        x: number
        y: number
        w: number
        name: string
        val: string
    } | null>(null)
    const color = (v: number | undefined) => {
        if (v === undefined) return "#D9D6D3"
        let b = 0
        while (b < metric.bins.length && v >= metric.bins[b]) b++
        return SCALE[metric.lowDark ? SCALE.length - 1 - b : b]
    }
    const legend = SCALE.map((_, i) => {
        const bn = metric.bins
        const f = (n: number) =>
            nf(n, metric.bins[0] < 5 ? 0 : bn[0] >= 1000 ? 0 : 1)
        return i === 0
            ? "< " + f(bn[0])
            : i === bn.length
              ? "> " + f(bn[bn.length - 1])
              : f(bn[i - 1]) + " – " + f(bn[i])
    })
    return (
        <section
            className="hx-card hx-world"
            aria-label="World energy"
            onMouseEnter={pause}
            onMouseLeave={resume}
            onFocusCapture={pause}
            onBlurCapture={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) resume()
            }}
            onPointerDown={(e) => {
                if (e.pointerType !== "mouse") pause()
            }}
        >
            <div className="hx-h">
                <h2 className="hx-t">World Energy</h2>
                <div className="hx-pills" role="group" aria-label="Map metric">
                    {METRICS.map((m) => (
                        <button
                            key={m.id}
                            className="hx-pill"
                            aria-pressed={m.id === metric.id}
                            onClick={() => setMetric(m.id)}
                        >
                            {m.label}
                            {rotate && m.id === metric.id ? (
                                <i
                                    key={m.id + ":" + run}
                                    className="hx-prog"
                                    aria-hidden="true"
                                    style={{
                                        animationDuration: secs + "s",
                                        animationPlayState: paused
                                            ? "paused"
                                            : "running",
                                    }}
                                />
                            ) : null}
                        </button>
                    ))}
                </div>
            </div>
            {!geo ? (
                <p className="cet-load">Loading map</p>
            ) : !geo.feats.length ? (
                <p className="cet-err">The map is temporarily unavailable.</p>
            ) : (
                <div
                    className="hx-mapwrap"
                    ref={wrap}
                    onMouseLeave={() => {
                        setTip(null)
                        setHov("")
                    }}
                >
                    <svg
                        className="hx-map"
                        viewBox={`0 0 ${geo.w} ${geo.h}`}
                        role="group"
                        aria-label="Click a country"
                    >
                        {geo.feats.map((f, i) => {
                            const v = f.iso3 ? vals.get(f.iso3) : undefined
                            const on = f.iso3 && f.iso3 === selected
                            return (
                                <path
                                    key={i}
                                    d={f.d}
                                    fill={color(v)}
                                    className={
                                        "hx-c" +
                                        (on ? " on" : "") +
                                        (f.iso3 ? " ok" : "")
                                    }
                                    role={f.iso3 ? "button" : undefined}
                                    tabIndex={f.iso3 ? 0 : undefined}
                                    aria-label={
                                        f.name +
                                        (v !== undefined
                                            ? ", " + metric.fmt(v)
                                            : "")
                                    }
                                    onClick={() => f.iso3 && onSelect(f.iso3)}
                                    onMouseEnter={() =>
                                        f.iso3 && setHov(f.iso3)
                                    }
                                    onFocus={() => f.iso3 && setHov(f.iso3)}
                                    onBlur={() => setHov("")}
                                    onMouseMove={(e) => {
                                        const r =
                                            wrap.current?.getBoundingClientRect()
                                        if (!r) return
                                        setTip({
                                            x: e.clientX - r.left,
                                            y: e.clientY - r.top,
                                            w: r.width,
                                            name: f.name,
                                            val:
                                                v !== undefined
                                                    ? metric.fmt(v)
                                                    : "no data",
                                        })
                                    }}
                                    onKeyDown={(e) => {
                                        if (
                                            f.iso3 &&
                                            (e.key === "Enter" || e.key === " ")
                                        ) {
                                            e.preventDefault()
                                            onSelect(f.iso3)
                                        }
                                    }}
                                />
                            )
                        })}
                        {hov && hov !== selected
                            ? geo.feats
                                  .filter((f) => f.iso3 === hov)
                                  .map((f, i) => (
                                      <path
                                          key={"h" + i}
                                          d={f.d}
                                          fill="none"
                                          stroke="var(--ink)"
                                          strokeOpacity="0.6"
                                          strokeWidth="1.2"
                                          strokeLinejoin="round"
                                          vectorEffect="non-scaling-stroke"
                                          pointerEvents="none"
                                      />
                                  ))
                            : null}
                        {geo.feats
                            .filter((f) => f.iso3 === selected)
                            .map((f, i) => (
                                <path
                                    key={"s" + i}
                                    d={f.d}
                                    fill="none"
                                    stroke="var(--ink)"
                                    strokeWidth="1.8"
                                    strokeLinejoin="round"
                                    vectorEffect="non-scaling-stroke"
                                    pointerEvents="none"
                                />
                            ))}
                    </svg>
                    {tip && (
                        <div
                            className="hx-mtip"
                            style={{
                                left: tip.x,
                                top: tip.y,
                                transform:
                                    tip.x > tip.w * 0.7
                                        ? "translate(calc(-100% - 12px), -50%)"
                                        : "translate(12px, -50%)",
                            }}
                        >
                            <b>{tip.name}</b>
                            <span>{metric.label}</span>
                            <em>{tip.val}</em>
                        </div>
                    )}
                </div>
            )}
            {entries && entries.length === 0 && err ? (
                <p className="cet-err" style={{ fontSize: 11.5 }} title={err}>
                    No data available for “{metric.label}”.
                </p>
            ) : null}
            <div className="hx-legend">
                {legend.map((l, i) => (
                    <span key={i}>
                        <i
                            style={{
                                background:
                                    SCALE[
                                        metric.lowDark
                                            ? SCALE.length - 1 - i
                                            : i
                                    ],
                            }}
                        />
                        {l}
                    </span>
                ))}
            </div>
        </section>
    )
}

function RankCard({
    title,
    rows,
    total,
    metric,
    onSelect,
    selected,
}: {
    title: string
    rows: Entry[]
    total: number
    metric: Metric
    onSelect: (iso: string) => void
    selected: string
}) {
    return (
        <section className="hx-card" aria-label={title}>
            <div className="hx-h hx-between">
                <h3 className="hx-t2">{title}</h3>
                <span className="hx-mute">
                    {total ? total + " economies" : ""}
                </span>
            </div>
            <ol className="hx-rank">
                {rows.map((r, i) => (
                    <li key={r.iso}>
                        <button
                            className={r.iso === selected ? "on" : ""}
                            onClick={() => onSelect(r.iso)}
                        >
                            <span className="hx-rk">{i + 1}</span>
                            <span className="hx-rn">{r.name}</span>
                            <span className="hx-rv">{metric.fmt(r.v)}</span>
                        </button>
                    </li>
                ))}
            </ol>
        </section>
    )
}

/* ------------------------------------------------------------------ */
/* Country panel                                                       */
/* ------------------------------------------------------------------ */

const gdpFmt = (v: number) => (v >= 1000 ? nf(v / 1000, 0) + "K" : nf(v, 0))
const TILES: { slug: string; label: string; fmt: (v: number) => string }[] = [
    { slug: "electricity-access", label: "Electricity access", fmt: pc },
    {
        slug: "renewable-electricity-share",
        label: "Renewable electricity",
        fmt: pc,
    },
    {
        slug: "co2-per-capita",
        label: "CO₂ per person",
        fmt: (v) => nf(v, 2) + " t",
    },
    {
        slug: "power-consumption-per-capita",
        label: "Consumption per person",
        fmt: (v) => nf(v, 0) + " kWh",
    },
    { slug: "clean-cooking", label: "Clean cooking", fmt: pc },
    { slug: "gdp-per-capita", label: "GDP per person", fmt: gdpFmt },
]

function Tile({
    base,
    t,
    c,
}: {
    base: string
    t: (typeof TILES)[number]
    c: Country
}) {
    const ind = useCSV(base, t.slug)
    const l = lastOf(ind?.byIso.get(c.iso3))
    const w = ind ? worldVal(ind) : null
    return (
        <div className="hx-tile">
            <small>{t.label}</small>
            <b>{l ? t.fmt(l.v) : ind ? "–" : ""}</b>
            <em>
                {[l ? l.y : "", w !== null ? "world " + t.fmt(w) : ""]
                    .filter(Boolean)
                    .join(" · ")}
            </em>
        </div>
    )
}

/* Source line built from the CSV columns source + retrieved_at (falls back to the fixed list) */
function SourceLine({ base, c }: { base: string; c: Country }) {
    const i0 = useCSV(base, TILES[0].slug)
    const i1 = useCSV(base, TILES[1].slug)
    const i2 = useCSV(base, TILES[2].slug)
    const i3 = useCSV(base, TILES[3].slug)
    const i4 = useCSV(base, TILES[4].slug)
    const i5 = useCSV(base, TILES[5].slug)
    const info = React.useMemo(() => {
        const src = new Set<string>()
        let ret = 0
        ;[i0, i1, i2, i3, i4, i5].forEach((ind) => {
            if (!ind) return
            const e = ind.byIso.get(c.iso3) || ind.byIso.values().next().value
            if (!e) return
            if (e.source) src.add(e.source.trim())
            const t = e.retrieved ? Date.parse(e.retrieved) : NaN
            if (isFinite(t) && t > ret) ret = t
        })
        return { src: Array.from(src), ret }
    }, [i0, i1, i2, i3, i4, i5, c.iso3])
    const parts = info.src.length ? [...info.src] : ["World Bank"]
    ;["U.S. EIA via FRED", "Ember", "Energy Institute", "Open-Meteo", "ECB"].forEach((s) => parts.push(s))
    const when = info.ret
        ? new Date(info.ret).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
          })
        : ""
    return (
        <p className="hx-src">
            {"Sources: " +
                parts.join(" · ") +
                (when ? " · updated " + when : "")}
        </p>
    )
}

function Mini({
    label,
    value,
    pts,
}: {
    label: string
    value: string
    pts: number[]
}) {
    return (
        <div className="hx-mini">
            <span>
                {label} <b>{value}</b>
            </span>
            <Line pts={pts} h={26} />
        </div>
    )
}

function MiniInd({
    base,
    slug,
    label,
    fmt,
    c,
}: {
    base: string
    slug: string
    label: string
    fmt: (v: number) => string
    c: Country
}) {
    const ind = useCSV(base, slug)
    const e = ind?.byIso.get(c.iso3)
    const l = lastOf(e)
    if (!l)
        return (
            <div className="hx-mini">
                <span>{label}</span>
            </div>
        )
    return <Mini label={label} value={fmt(l.v)} pts={e!.pts.map((p) => p.v)} />
}

type ERow = {
    label: string
    v: number
    unit?: string
    year?: string
    rank?: string
    series?: number[]
    dec?: number
}

function eiaRows(data: any, c: Country): ERow[] {
    // eiaintl.json: [ { id, name, unit, decimals, values: { ISO3: [ {year, value} ] } } ]
    if (
        Array.isArray(data) &&
        data.some((m) => m && m.values && typeof m.values === "object")
    ) {
        const res: ERow[] = []
        data.forEach((m: any) => {
            if (!m || !m.values) return
            const arr = m.values[c.iso3]
            if (!Array.isArray(arr) || !arr.length) return
            const pts = arr
                .map((p: any) => ({ y: num(p.year), v: num(p.value) }))
                .filter((p: any) => p.y !== null && p.v !== null) as {
                y: number
                v: number
            }[]
            if (!pts.length) return
            const last = pts[pts.length - 1]
            let rank = 1
            let total = 0
            Object.keys(m.values).forEach((k) => {
                const a = m.values[k]
                if (!Array.isArray(a) || !a.length) return
                const lv = num(a[a.length - 1].value)
                if (lv !== null && lv > 0) {
                    total++
                    if (k !== c.iso3 && lv > last.v) rank++
                }
            })
            res.push({
                label: String(m.name || m.id),
                v: last.v,
                unit: typeof m.unit === "string" ? m.unit : undefined,
                year: String(last.y),
                rank:
                    total && last.v > 0 ? "#" + rank + "/" + total : undefined,
                series: pts.length > 2 ? pts.map((p) => p.v) : undefined,
                dec: isNum(m.decimals) ? m.decimals : undefined,
            })
        })
        return res
    }
    const out: ERow[] = []
    walk(data, (item, path, sibs, hint) => {
        const o = lc(item)
        if (!sameCountry(c, idOf(o, hint))) return
        const metric = path
            .filter((p) => isNaN(Number(p)))
            .slice(-2)
            .join(" ")
        const v = pickNum(o, VALUE_KEYS)
        if (v !== null && sibs) {
            const vals = sibs
                .map((s) => pickNum(lc(s), VALUE_KEYS))
                .filter((n): n is number => n !== null)
            const rank = 1 + vals.filter((n) => n > v).length
            let series: number[] | undefined
            for (const k of SERIES_KEYS) if ((series = toSeries(o[k]))) break
            out.push({
                label: pretty(metric || "Value"),
                v,
                unit: sv(pickKey(o, ["unit", "units"])),
                year: o.year != null ? String(o.year) : undefined,
                rank: `#${rank}/${vals.length}`,
                series,
            })
        } else {
            Object.keys(o).forEach((k) => {
                if (
                    NAME_KEYS.includes(k) ||
                    ID_KEYS.includes(k) ||
                    SKIP_NUM.test(k)
                )
                    return
                const ch = o[k]
                if (isNum(ch))
                    out.push({
                        label: pretty(k),
                        v: ch,
                        year: o.year != null ? String(o.year) : undefined,
                    })
                else if (ch && typeof ch === "object" && !Array.isArray(ch)) {
                    const co = lc(ch)
                    const n = pickNum(co, VALUE_KEYS)
                    if (n !== null) {
                        let series: number[] | undefined
                        for (const sk of SERIES_KEYS)
                            if ((series = toSeries(co[sk]))) break
                        out.push({
                            label: pretty(k),
                            v: n,
                            unit: sv(co.unit),
                            year: co.year != null ? String(co.year) : undefined,
                            rank:
                                co.rank != null
                                    ? "#" +
                                      co.rank +
                                      (co.total || co.of
                                          ? "/" + (co.total || co.of)
                                          : "")
                                    : undefined,
                            series,
                        })
                    }
                }
            })
        }
    })
    const seen = new Set<string>()
    return out
        .filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)))
        .slice(0, 8)
}

function CountryPanel({
    base,
    refreshMs,
    c,
    countries,
    onSelect,
}: {
    base: string
    refreshMs: number
    c: Country
    countries: Country[]
    onSelect: (iso: string) => void
}) {
    const eia = usePanel(base, "/api/v1/eiaintl.json", refreshMs * 6)
    const ember = usePanel(base, "/api/v1/ember.json", refreshMs * 6)
    const sol = usePanel(base, "/api/v1/solar.json", refreshMs)
    const fx = usePanel(base, "/api/v1/fx.json", refreshMs)
    const fxh = usePanel(base, "/api/v1/fxhist.json", refreshMs * 6)
    const wb = usePanel(base, "/api/v1/worldbank.json", refreshMs * 6)

    const erows = React.useMemo(
        () => (eia.json ? eiaRows(eia.json.data ?? eia.json, c) : []),
        [eia.json, c]
    )
    const mix = React.useMemo(() => {
        let best: Mix | null = null
        let bestY = -1
        if (ember.json)
            walk(ember.json.data ?? ember.json, (item, _p, _s, hint) => {
                const o = lc(item)
                if (!sameCountry(c, idOf(o, hint))) return
                const st = emberStats(o)
                if (!st) return
                const y = parseInt(st.year || "0", 10) || 0
                const score =
                    y * 10 +
                    st.shares.length +
                    (st.total !== null ? 1 : 0) +
                    (st.monthly ? 2 : 0)
                if (!best || score >= bestY) {
                    best = st
                    bestY = score
                }
            })
        const m = best as Mix | null
        if (!m || !ember.json) return m
        const d = ember.json.data ?? ember.json
        const inten = d && d.intensity ? d.intensity[c.iso3] : undefined
        const carbon =
            m.carbon ??
            (inten && typeof inten === "object"
                ? pickNum(lc(inten), ["value", "intensity", "gco2"])
                : isNum(inten)
                  ? inten
                  : null)
        const mo = d && d.monthly ? d.monthly[c.iso3] : undefined
        const mp = mo ? toPts(mo) : []
        return {
            ...m,
            carbon,
            monthly: mp.length > 2 ? mp.map((p) => p.v) : m.monthly,
            monthEnd: mp.length
                ? shortDate(mp[mp.length - 1].d)?.slice(0, 7)
                : undefined,
        }
    }, [ember.json, c])

    const capital = React.useMemo(() => {
        let cap: string | undefined,
            region: string | undefined,
            income: string | undefined,
            lat: number | null = null,
            lon: number | null = null
        if (wb.json)
            walk(wb.json.data ?? wb.json, (item, _p, _s, hint) => {
                const o = lc(item)
                if (!sameCountry(c, idOf(o, hint))) return
                region = region || sv(pickKey(o, ["region", "regionname"]))
                income =
                    income ||
                    sv(
                        pickKey(o, [
                            "incomelevel",
                            "income",
                            "incomegroup",
                            "income_level",
                        ])
                    )
                cap =
                    cap ||
                    sv(pickKey(o, ["capitalcity", "capital", "capital_city"]))
                if (lat === null) lat = pickNum(o, ["latitude", "lat"])
                if (lon === null) lon = pickNum(o, ["longitude", "lon", "lng"])
            })
        return {
            cap,
            lat,
            lon,
            line: [region, income, cap ? "Capital " + cap : ""]
                .filter(Boolean)
                .join(" · "),
        }
    }, [wb.json, c])

    const sun = React.useMemo(() => {
        if (!sol.json) return null
        let hit: { city: string; v: number } | null = null
        walk(sol.json.data ?? sol.json, (item, _p, _s, hint) => {
            if (hit) return
            const o = lc(item)
            const city =
                sv(pickKey(o, ["city", "name", "location", "place"])) ||
                (hint && isNaN(Number(hint)) ? hint : undefined)
            if (!city) return
            const byCity = capital.cap && canon(city) === canon(capital.cap)
            const byCountry = sameCountry(
                c,
                idOf({
                    country: o.country,
                    countrycode: o.countrycode,
                    iso3: o.iso3,
                })
            )
            if (!byCity && !byCountry) return
            let v = pickNum(o, [
                "today",
                "value",
                "irradiation",
                "shortwave",
                "ghi",
                "kwh",
                "kwh_m2",
                "sum",
            ])
            if (v === null) {
                const dp = toPts(o.days)
                if (dp.length) v = todayPt(dp).v
            }
            if (v === null) {
                const s =
                    toSeries(o.daily) ||
                    toSeries(o.forecast) ||
                    toSeries(o.values)
                v = s ? s[0] : null
            }
            if (v !== null) hit = { city, v }
        })
        return hit as { city: string; v: number } | null
    }, [sol.json, c, capital.cap])

    // City not in solar.json: ask Open-Meteo directly for the capital (or the country)
    const [sun2, setSun2] = React.useState<{ city: string; v: number } | null>(
        null
    )
    const wbDone = !!wb.json || wb.state === "error"
    const solDone = !!sol.json || sol.state === "error"
    React.useEffect(() => {
        setSun2(null)
        if (sun || !wbDone || !solDone) return
        let alive = true
        const name = capital.cap || c.name
        const a2 = c.iso2 || ISO3_2[c.iso3]
        const where: Promise<{ lat: number; lon: number } | null> =
            capital.lat !== null && capital.lon !== null
                ? Promise.resolve({ lat: capital.lat, lon: capital.lon })
                : getJSON(
                      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" +
                          encodeURIComponent(name) +
                          (a2 ? "&countryCode=" + a2 : ""),
                      864e5
                  ).then((j) => {
                      const r = j && j.results && j.results[0]
                      return r ? { lat: r.latitude, lon: r.longitude } : null
                  })
        where
            .then((g) =>
                g
                    ? getJSON(
                          "https://api.open-meteo.com/v1/forecast?daily=shortwave_radiation_sum,sunshine_duration&timezone=auto&forecast_days=1&latitude=" +
                              g.lat.toFixed(3) +
                              "&longitude=" +
                              g.lon.toFixed(3),
                          3600e3
                      )
                    : null
            )
            .then((j) => {
                const mj = j && j.daily && j.daily.shortwave_radiation_sum
                const v = Array.isArray(mj) ? num(mj[0]) : null
                // MJ/m² -> kWh/m²
                if (alive && v !== null) setSun2({ city: name, v: v / 3.6 })
            })
            .catch(() => {})
        return () => {
            alive = false
        }
    }, [c.iso3, capital.cap, capital.lat, capital.lon, !!sun, wbDone, solDone])
    const sunShow = sun || sun2

    const dbg = React.useMemo(() => {
        if (!DEBUG_RAW) return ""
        const out: string[] = []
        const grab = (label: string, json: any) => {
            if (!json) {
                out.push("== " + label + ": loading")
                return
            }
            const data = json.data ?? json
            if (label === "eiaintl" && Array.isArray(data)) {
                out.push("== eiaintl: " + data.length + " items")
                data.slice(0, 8).forEach((it: any, i: number) =>
                    out.push(
                        "-- [" + i + "] " + JSON.stringify(it).slice(0, 450)
                    )
                )
                return
            }
            if (label === "ember" && data && data.monthly) {
                const mk = Object.keys(data.monthly)
                out.push(
                    "== ember.monthly: " +
                        mk.length +
                        " keys, e.g. " +
                        mk.slice(0, 4).join(", ")
                )
                const k0 = data.monthly[c.iso3] ? c.iso3 : mk[0]
                out.push(
                    "-- monthly." +
                        k0 +
                        " " +
                        JSON.stringify(data.monthly[k0]).slice(0, 500)
                )
            }
            const hits: [string, any][] = []
            walk(data, (item, path, _s, hint) => {
                if (hits.length >= 5) return
                if (sameCountry(c, idOf(lc(item), hint)))
                    hits.push([path.join(".") + (hint ? "." + hint : ""), item])
            })
            out.push(
                "== " +
                    label +
                    " | top keys: " +
                    Object.keys(data).slice(0, 14).join(", ")
            )
            hits.forEach(([pth, it]) =>
                out.push("-- " + pth + "\n" + JSON.stringify(it).slice(0, 1400))
            )
            if (!hits.length)
                out.push("no match for " + c.iso3 + " / " + c.name)
        }
        grab("eiaintl", eia.json)
        grab("ember", ember.json)
        return out.join("\n")
    }, [eia.json, ember.json, c])

    const cur = CURRENCY[c.iso3]
    const curHist =
        cur && fxh.json
            ? thin(fxSeries(fxh.json.data ?? fxh.json, cur), 60).map((p) => p.v)
            : []
    const curLast =
        cur && fx.json?.data?.usd ? fx.json.data.usd[cur] : undefined

    return (
        <section
            className="hx-card hx-country"
            aria-label="Country"
            aria-live="polite"
        >
            <div className="hx-h hx-between">
                <h2 className="hx-t red">Country</h2>
                <label className="hx-sel">
                    <span className="hx-vh">Search a country</span>
                    <select
                        value=""
                        onChange={(e) =>
                            e.target.value && onSelect(e.target.value)
                        }
                        aria-label="Search a country"
                    >
                        <option value="">Search a country</option>
                        {countries.map((k) => (
                            <option key={k.iso3} value={k.iso3}>
                                {k.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="hx-chead">
                {c.iso2 ? (
                    <img
                        className="hx-flag"
                        src={`https://flagcdn.com/w80/${c.iso2.toLowerCase()}.png`}
                        alt=""
                        width="40"
                        height="28"
                    />
                ) : (
                    <span className="hx-flag" />
                )}
                <div>
                    <h3 className="hx-cname">{c.name}</h3>
                    <p className="hx-meta">{capital.line}</p>
                </div>
            </div>

            <div className="hx-tiles">
                {TILES.map((t) => (
                    <Tile key={t.slug} base={base} t={t} c={c} />
                ))}
            </div>

            {erows.length > 0 && (
                <>
                    <p className="hx-cap">
                        Energy production and use, TWh (Energy Institute,
                        Ember)
                    </p>
                    <table className="hx-eia">
                        <tbody>
                            {erows.map((r, i) => (
                                <tr key={i}>
                                    <td>{r.label}</td>
                                    <td className="hx-n">
                                        {nf(
                                            r.v,
                                            Math.abs(r.v) >= 100
                                                ? 0
                                                : (r.dec ?? 1)
                                        )}
                                        {r.unit ? " " + r.unit : ""}
                                    </td>
                                    <td className="hx-n hx-mute">
                                        {[r.year, r.rank]
                                            .filter(Boolean)
                                            .join(" ")}
                                    </td>
                                    <td className="hx-sp2">
                                        {r.series ? (
                                            <Line pts={r.series} h={14} />
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}

            {mix && (
                <>
                    <p className="hx-cap">
                        {[
                            "Power generation" +
                                (mix.year ? " " + mix.year : ""),
                            mix.total !== null ? nf(mix.total, 1) + " TWh" : "",
                            mix.clean !== null
                                ? Math.round(mix.clean) + "% clean"
                                : "",
                            mix.carbon !== null
                                ? Math.round(mix.carbon) + " gCO₂/kWh"
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" · ") + " (Ember)"}
                    </p>
                    {mix.shares.length > 0 && (
                        <>
                            <div
                                className="hx-mix"
                                role="img"
                                aria-label="Electricity mix"
                            >
                                {mix.shares
                                    .filter((s) => s.pct >= 0.5)
                                    .map((s) => (
                                        <span
                                            key={s.name}
                                            style={{
                                                flex: s.pct,
                                                background: s.color,
                                                color:
                                                    s.pct > 20 ||
                                                    s.color.startsWith("#8") ||
                                                    s.color.startsWith("#5")
                                                        ? "#fff"
                                                        : "var(--ink)",
                                            }}
                                        >
                                            {s.pct >= 7
                                                ? Math.round(s.pct) + "%"
                                                : ""}
                                        </span>
                                    ))}
                            </div>
                            <p className="hx-legend2">
                                {mix.shares
                                    .filter((s) => s.pct >= 0.1)
                                    .map(
                                        (s) =>
                                            `${s.name} ${s.pct < 1 ? "<1" : Math.round(s.pct)}%`
                                    )
                                    .join(" · ")}
                            </p>
                        </>
                    )}
                    {mix.monthly && (
                        <>
                            <p className="hx-cap">
                                Clean share by month
                                {", " +
                                    (mix.monthEnd
                                        ? "to " + mix.monthEnd + ": "
                                        : "latest ") +
                                    nf(mix.monthly[mix.monthly.length - 1], 1) +
                                    "%"}
                            </p>
                            <Line pts={mix.monthly} h={34} />
                        </>
                    )}
                </>
            )}

            <div className="hx-minis">
                <MiniInd
                    base={base}
                    slug="electricity-access"
                    label="Electricity access"
                    fmt={pc}
                    c={c}
                />
                <MiniInd
                    base={base}
                    slug="co2-per-capita"
                    label="CO₂ per person"
                    fmt={(v) => nf(v, 2) + " t"}
                    c={c}
                />
                {cur && curLast ? (
                    <Mini
                        label={"USD/" + cur}
                        value={nf(curLast, curLast >= 100 ? 2 : 2)}
                        pts={curHist}
                    />
                ) : (
                    <div />
                )}
                {sunShow ? (
                    <div className="hx-mini">
                        <span>Sun in {sunShow.city} today</span>
                        <b className="hx-sun">{nf(sunShow.v, 1)} kWh/m²</b>
                    </div>
                ) : (
                    <div />
                )}
            </div>
            {DEBUG_RAW && (
                <details className="cet-empty">
                    <summary>Debug: raw API data for {c.name}</summary>
                    <pre style={{ maxHeight: 320 }}>{dbg}</pre>
                </details>
            )}
            <SourceLine base={base} c={c} />
        </section>
    )
}

/* ------------------------------------------------------------------ */
/* Dashboard assembly                                                  */
/* ------------------------------------------------------------------ */

function Dashboard({
    base,
    refreshMs,
    benchSlider,
    benchSpeed,
    worldRotate,
    worldSpeed,
    defaultMetric,
    selected,
    setSelected,
}: {
    base: string
    refreshMs: number
    benchSlider?: boolean
    benchSpeed?: number
    worldRotate?: boolean
    worldSpeed?: number
    defaultMetric: string
    selected: string
    setSelected: (iso: string) => void
}) {
    const [metricId, setMetricId] = React.useState(defaultMetric)
    React.useEffect(() => setMetricId(defaultMetric), [defaultMetric])

    const geo = useGeo()
    const metric = METRICS.find((m) => m.id === metricId) || METRICS[0]
    const nameIso = React.useMemo(() => {
        const m = new Map<string, string>()
        geo?.feats.forEach((f) => f.iso3 && m.set(canon(f.name), f.iso3))
        return m
    }, [geo])
    const entries = useEntries(base, metric, refreshMs, nameIso)
    const access = useCSV(base, "electricity-access")
    const metricInd = useCSV(base, metric.slug || "")

    const countries = React.useMemo(() => {
        const m = new Map<string, Country>()
        geo?.feats.forEach(
            (f) =>
                f.iso3 &&
                m.set(f.iso3, { iso3: f.iso3, iso2: f.iso2, name: f.name })
        )
        access?.byIso.forEach((e, iso) => {
            if (!m.has(iso) && !AGG.test(e.name))
                m.set(iso, { iso3: iso, name: e.name })
        })
        return Array.from(m.values()).sort((a, b) =>
            a.name.localeCompare(b.name)
        )
    }, [geo, access])
    const byIso = React.useMemo(
        () => new Map(countries.map((k) => [k.iso3, k])),
        [countries]
    )
    const country: Country = byIso.get(selected) || {
        iso3: selected,
        iso2: ISO3_2[selected],
        name: regionName(selected),
    }

    const ranked = React.useMemo(() => {
        const list = (entries || []).map((e) => ({
            ...e,
            name: byIso.get(e.iso)?.name || e.name,
        }))
        const sorted = [...list].sort((a, b) => b.v - a.v)
        return {
            hi: sorted.slice(0, 5),
            lo: sorted.slice(-5).reverse(),
            n: sorted.length,
        }
    }, [entries, byIso])

    return (
        <div className="hx">
            <div style={{ gridArea: "bench" }}>
                <BenchPanel
                    base={base}
                    refreshMs={refreshMs}
                    slider={benchSlider !== false}
                    speed={benchSpeed}
                />
            </div>
            <div style={{ gridArea: "fx" }}>
                <FxPanel base={base} refreshMs={refreshMs} />
            </div>
            <div style={{ gridArea: "world" }}>
                <WorldPanel
                    geo={geo}
                    metric={metric}
                    setMetric={setMetricId}
                    entries={entries}
                    selected={selected}
                    onSelect={setSelected}
                    err={metricInd?.err}
                    rotate={worldRotate !== false}
                    speed={worldSpeed}
                />
            </div>
            <div style={{ gridArea: "hl" }} className="hx-hl">
                <RankCard
                    title="Highest"
                    rows={ranked.hi}
                    total={ranked.n}
                    metric={metric}
                    onSelect={setSelected}
                    selected={selected}
                />
                <RankCard
                    title="Lowest"
                    rows={ranked.lo}
                    total={ranked.n}
                    metric={metric}
                    onSelect={setSelected}
                    selected={selected}
                />
            </div>
            <div style={{ gridArea: "country" }}>
                <CountryPanel
                    base={base}
                    refreshMs={refreshMs}
                    c={country}
                    countries={countries}
                    onSelect={setSelected}
                />
            </div>
        </div>
    )
}

/* ------------------------------------------------------------------ */
/* Extra panels (Signals, Commodities, ... Pump prices)                */
/* ------------------------------------------------------------------ */

type XId =
    | "signals"
    | "commodities"
    | "equities"
    | "powerhours"
    | "producers"
    | "usweekly"
    | "calendar"
    | "worldenergy"
    | "sun"
    | "pump"

const XPANELS: { id: XId; title: string; tags: string[] }[] = [
    { id: "signals", title: "Signals", tags: ["overview", "markets"] },
    {
        id: "commodities",
        title: "Commodities",
        tags: ["overview", "markets", "oil"],
    },
    { id: "equities", title: "Energy equities", tags: ["overview", "markets"] },
    {
        id: "powerhours",
        title: "European power, hour by hour",
        tags: ["overview", "power"],
    },
    {
        id: "producers",
        title: "World producers",
        tags: ["overview", "oil", "power", "renewables"],
    },
    { id: "usweekly", title: "US fundamentals", tags: ["overview", "oil"] },
    { id: "calendar", title: "Release calendar", tags: ["overview", "news"] },
    {
        id: "worldenergy",
        title: "World energy",
        tags: ["overview", "power", "renewables"],
    },
    { id: "sun", title: "Sun today", tags: ["overview", "renewables"] },
    { id: "pump", title: "Pump prices", tags: ["overview", "oil"] },
]
const XIDS: XId[] = XPANELS.map((p) => p.id)

type XCtx = {
    base: string
    refreshMs: number
    rows: number
    signalRows: number
    producerRows: number
    calendarRows: number
    pumpRows: number
    selected: string
    onSelect: (iso: string) => void
    calTz: string
    calTzLabel: string
    briefTitle: string
}

function gate(res: PanelState, what: string): React.ReactNode | null {
    if (res.state === "error")
        return (
            <p className="cet-err" title={res.error}>
                Data temporarily unavailable.
            </p>
        )
    if (!res.json) return <p className="cet-load">Loading {what}</p>
    return null
}

const srcName = (json: any, fb: string) =>
    json?.source ? json.source.publisher || json.source.name || fb : fb

function XCard({
    title,
    meta,
    children,
    foot,
}: {
    title: string
    meta?: React.ReactNode
    children: React.ReactNode
    foot?: React.ReactNode
}) {
    return (
        <section className="hx-card xp-card" aria-label={title}>
            <div className="hx-h hx-between">
                <h2 className="hx-t">{title}</h2>
                {meta ? <span className="hx-mute">{meta}</span> : null}
            </div>
            {children}
            {foot ? <p className="xp-note">{foot}</p> : null}
        </section>
    )
}

/* ---- Signals: latest move vs. the series' own past-year volatility ---- */

function zMove(pts: Pt[]): { chg: number; z: number } | null {
    if (pts.length < 12) return null
    const lastT = toDate(pts[pts.length - 1].d)
    const from = lastT !== null ? lastT - 366 * 864e5 : null
    const r: number[] = []
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1].v
        if (!a) continue
        if (from !== null) {
            const t = toDate(pts[i].d)
            if (t !== null && t < from) continue
        }
        r.push(((pts[i].v - a) / Math.abs(a)) * 100)
    }
    if (r.length < 10) return null
    const last = r[r.length - 1]
    const h = r.slice(0, -1)
    const m = h.reduce((a, b) => a + b, 0) / h.length
    const sd = Math.sqrt(
        h.reduce((a, b) => a + (b - m) * (b - m), 0) / (h.length - 1)
    )
    if (!sd) return null
    return { chg: last, z: Math.abs(last - m) / sd }
}

const SIG_FX = [
    "CAD",
    "GBP",
    "EUR",
    "ZAR",
    "AUD",
    "JPY",
    "MXN",
    "CNY",
    "INR",
    "BRL",
    "CHF",
    "NOK",
    "KRW",
    "TRY",
]

function SignalsX({ ctx }: { ctx: XCtx }) {
    const fxh = usePanel(ctx.base, "/api/v1/fxhist.json", ctx.refreshMs * 6)
    const eia = usePanel(ctx.base, "/api/v1/eiaweekly.json", ctx.refreshMs)
    const fred = usePanel(ctx.base, "/api/v1/fred.json", ctx.refreshMs * 6)
    const list = React.useMemo(() => {
        const out: { label: string; sub: string; chg: number; z: number }[] = []
        if (fxh.json) {
            const d = fxh.json.data ?? fxh.json
            SIG_FX.forEach((c) => {
                const p = fxSeries(d, c)
                const s = zMove(p)
                if (s)
                    out.push({
                        label: "USD/" + c,
                        sub: [
                            "Currencies",
                            p.length && shortDate(p[p.length - 1].d)
                                ? "day to " + shortDate(p[p.length - 1].d)
                                : "",
                        ]
                            .filter(Boolean)
                            .join(" · "),
                        ...s,
                    })
            })
        }
        const add = (json: any, group: string, per: string) => {
            if (!json) return
            collect(json.data ?? json).forEach(([k, x]) => {
                const row = toRow([k, x])
                const p = toPts(x)
                const s = zMove(p)
                if (!row || !s) return
                const dt = shortDate(p[p.length - 1].d) || row.sub
                out.push({
                    label: row.label,
                    sub: [group, dt ? per + " to " + dt : ""]
                        .filter(Boolean)
                        .join(" · "),
                    ...s,
                })
            })
        }
        add(eia.json, "US fundamentals", "week")
        add(fred.json, "Commodities", "month")
        return out.sort((a, b) => b.z - a.z).slice(0, ctx.signalRows)
    }, [fxh.json, eia.json, fred.json, ctx.signalRows])

    const wait =
        !fxh.json && !eia.json && !fred.json ? gate(fxh, "signals") : null
    return (
        <XCard
            title="Signals"
            meta="Unusual moves, in standard deviations"
            foot="Each move is compared with that series' own history of changes over the past year. Descriptive, not a forecast."
        >
            {wait ? (
                wait
            ) : !list.length ? (
                <Empty json={fxh.json} />
            ) : (
                <table className="xp-tbl">
                    <tbody>
                        {list.map((r) => (
                            <tr key={r.label + r.sub}>
                                <td className="xp-l">
                                    {r.label}
                                    <small>{r.sub}</small>
                                </td>
                                <td className={"xp-n " + dir(r.chg)}>
                                    {signed(r.chg, 2)}%
                                </td>
                                <td className="xp-n">
                                    <span
                                        className={
                                            "xp-sig" + (r.z >= 2 ? " hot" : "")
                                        }
                                    >
                                        {nf(r.z, 1)}σ
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </XCard>
    )
}

/* ---- Commodities (monthly, IMF via FRED) ---- */

const kfmt = (v: number) =>
    Math.abs(v) >= 10000
        ? nf(v / 1000, 1) + "k"
        : Math.abs(v) >= 100
          ? nf(v, 0)
          : nf(v, 2)
const pcell = (v: number | null) => (
    <td className={"xp-n " + dir(v)}>{v === null ? "" : signed(v, 1) + "%"}</td>
)

function CommoditiesX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/fred.json", ctx.refreshMs)
    const rows = React.useMemo(() => {
        if (!res.json) return []
        return collect(res.json.data ?? res.json)
            .map(([k, x]) => {
                const row = toRow([k, x])
                if (!row || row.value === null) return null
                const p = toPts(x)
                const last = p.length ? p[p.length - 1] : null
                return {
                    label: row.label,
                    sub: [
                        row.unit,
                        last ? shortDate(last.d)?.slice(0, 7) : row.sub,
                    ]
                        .filter(Boolean)
                        .join(" · "),
                    v: last ? last.v : (row.value as number),
                    m1: p.length ? pctBack(p, 28, 1) : row.pct,
                    y1: p.length ? pctBack(p, 360, 12) : null,
                    s: thin(sliceRange(p, 1096), 60).map((q) => q.v),
                }
            })
            .filter((r): r is NonNullable<typeof r> => !!r)
            .slice(0, ctx.rows)
    }, [res.json, ctx.rows])
    const wait = gate(res, "commodities")
    return (
        <XCard
            title="Commodities"
            meta={"Monthly · " + srcName(res.json, "IMF via FRED")}
        >
            {wait ? (
                wait
            ) : !rows.length ? (
                <Empty json={res.json} />
            ) : (
                <table className="xp-tbl">
                    <thead>
                        <tr>
                            <th>Benchmark</th>
                            <th className="xp-n">Latest</th>
                            <th className="xp-n">1M</th>
                            <th className="xp-n">1Y</th>
                            <th className="xp-n xp-spark">3Y</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.label}>
                                <td className="xp-l">
                                    {r.label}
                                    {r.sub ? <small>{r.sub}</small> : null}
                                </td>
                                <td className="xp-n">{kfmt(r.v)}</td>
                                {pcell(r.m1)}
                                {pcell(r.y1)}
                                <td className="xp-spark">
                                    {r.s.length > 2 ? (
                                        <Line pts={r.s} h={20} />
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </XCard>
    )
}

/* ---- Energy equities ---- */

function EquitiesX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/equities.json", ctx.refreshMs)
    const rows = React.useMemo(() => {
        if (!res.json) return []
        return collect(res.json.data ?? res.json)
            .map(([k, x]) => {
                const row = toRow([k, x])
                if (!row || row.value === null) return null
                const o = lc(x)
                return {
                    name:
                        sv(
                            pickKey(o, [
                                "name",
                                "company",
                                "longname",
                                "shortname",
                                "label",
                            ])
                        ) || row.label,
                    tick: sv(pickKey(o, ["symbol", "ticker", "code"])),
                    grp: sv(
                        pickKey(o, [
                            "group",
                            "sector",
                            "category",
                            "segment",
                            "industry",
                            "type",
                        ])
                    ),
                    cur: sv(pickKey(o, ["currency", "ccy"])),
                    v: row.value as number,
                    pct: row.pct,
                    sub: row.sub,
                }
            })
            .filter((r): r is NonNullable<typeof r> => !!r)
            .slice(0, ctx.rows)
    }, [res.json, ctx.rows])
    const when = res.json?.retrievedAt || rows[0]?.sub
    const wait = gate(res, "equities")
    return (
        <XCard
            title="Energy equities"
            meta={["Daily close", when ? fdate(when) : ""]
                .filter(Boolean)
                .join(" · ")}
        >
            {wait ? (
                wait
            ) : !rows.length ? (
                <Empty json={res.json} />
            ) : (
                <table className="xp-tbl">
                    <thead>
                        <tr>
                            <th>Company</th>
                            <th className="xp-n">Last</th>
                            <th className="xp-n">Day</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => (
                            <tr key={r.name + i}>
                                <td className="xp-l">
                                    {r.name}
                                    {r.tick || r.grp ? (
                                        <small>
                                            {[r.tick, r.grp]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </small>
                                    ) : null}
                                </td>
                                <td className="xp-n">
                                    {r.cur && !/usd|\$/i.test(r.cur)
                                        ? nf(r.v, 2) + " " + r.cur.toUpperCase()
                                        : "$" + nf(r.v, 2)}
                                </td>
                                {pcell(r.pct)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </XCard>
    )
}

/* ---- European power, hour by hour (ENTSO-E day-ahead) ---- */

function hours24(s: number[]): number[] {
    if (s.length === 96) {
        const out: number[] = []
        for (let i = 0; i < 24; i++)
            out.push(
                (s[i * 4] + s[i * 4 + 1] + s[i * 4 + 2] + s[i * 4 + 3]) / 4
            )
        return out
    }
    return s.slice(-24)
}

function PowerHoursX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/entsoe.json", ctx.refreshMs)
    const data = React.useMemo(() => {
        if (!res.json) return null
        const list = rowsOf(res.json.data ?? res.json)
            .map((r) => {
                const s = r.series ? hours24(r.series) : []
                const avg = s.length
                    ? s.reduce((a, b) => a + b, 0) / s.length
                    : (r.value as number)
                return { label: r.label, s, avg, sub: r.sub }
            })
            .sort((a, b) => b.avg - a.avg)
        let lo = Infinity
        let hi = -Infinity
        list.forEach((r) =>
            (r.s.length ? r.s : [r.avg]).forEach((v) => {
                if (v < lo) lo = v
                if (v > hi) hi = v
            })
        )
        const d = res.json.data ?? res.json
        const date =
            shortDate(d && (d.date || d.day || d.deliveryDate)) ||
            list[0]?.sub ||
            (res.json.retrievedAt ? fdate(res.json.retrievedAt) : "")
        return { list, lo, hi, date }
    }, [res.json])
    const wait = gate(res, "power prices")
    const op = (v: number) =>
        data ? 0.08 + 0.92 * ((v - data.lo) / (data.hi - data.lo || 1)) : 1
    return (
        <XCard
            title="European power, hour by hour"
            meta={
                data
                    ? [data.date, data.list.length + " countries", "€/MWh"]
                          .filter(Boolean)
                          .join(" · ")
                    : "€/MWh"
            }
            foot="Each cell is one hour, 00:00 to 23:00. Darker is dearer; the figure is the daily average."
        >
            {wait ? (
                wait
            ) : !data || !data.list.length ? (
                <Empty json={res.json} />
            ) : (
                <div className="xp-ph">
                    {data.list.map((r) => (
                        <div className="xp-phr" key={r.label}>
                            <span className="xp-ell">{r.label}</span>
                            {r.s.length ? (
                                <span
                                    className="xp-cells"
                                    role="img"
                                    aria-label={`${r.label}, ${nf(Math.min(...r.s), 0)} to ${nf(Math.max(...r.s), 0)} €/MWh`}
                                >
                                    {r.s.map((v, i) => (
                                        <i
                                            key={i}
                                            title={
                                                String(i).padStart(2, "0") +
                                                ":00 · " +
                                                nf(v, 1)
                                            }
                                            style={{ opacity: op(v) }}
                                        />
                                    ))}
                                </span>
                            ) : (
                                <span className="xp-track">
                                    <i
                                        style={{
                                            width:
                                                Math.max(
                                                    2,
                                                    (r.avg / (data.hi || 1)) *
                                                        100
                                                ) + "%",
                                        }}
                                    />
                                </span>
                            )}
                            <b>{nf(r.avg, 1)}</b>
                        </div>
                    ))}
                </div>
            )}
        </XCard>
    )
}

/* ---- World producers (US EIA international) ---- */

const PROD_TABS: { id: string; label: string; re: RegExp; pref: RegExp }[] = [
    {
        id: "oil",
        label: "Oil",
        re: /crude|petroleum|\boil\b|liquids/,
        pref: /produc|supply/,
    },
    {
        id: "gas",
        label: "Gas",
        re: /natural gas|dry gas|\bgas\b/,
        pref: /produc/,
    },
    { id: "coal", label: "Coal", re: /coal/, pref: /produc/ },
    {
        id: "power",
        label: "Power",
        re: /electric|power/,
        pref: /generat|produc/,
    },
    {
        id: "renew",
        label: "Renewables",
        re: /renew/,
        pref: /generat|produc|electric/,
    },
]
const PROD_NOT = /consum|import|export|reserve|capacity|intensity|per capita/

function pickMetric(arr: any[], t: (typeof PROD_TABS)[number]) {
    let best: any = null
    let bs = -1
    arr.forEach((m) => {
        if (!m || !m.values || typeof m.values !== "object") return
        const s = (
            String(m.id || "") +
            " " +
            String(m.name || "")
        ).toLowerCase()
        if (!t.re.test(s)) return
        if (t.id !== "renew" && /renew/.test(s)) return
        if (t.id === "gas" && /gasoline/.test(s)) return
        const sc = (t.pref.test(s) ? 2 : 0) - (PROD_NOT.test(s) ? 3 : 0)
        if (sc > bs) {
            bs = sc
            best = m
        }
    })
    return best
}

const vfmt = (v: number, dec = 1) =>
    Math.abs(v) >= 10000
        ? nf(v / 1000, 1) + "k"
        : nf(v, Math.abs(v) >= 100 ? 0 : dec)

function ProducersX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/eiaintl.json", ctx.refreshMs * 6)
    const [tab, setTab] = React.useState("oil")
    const metrics = React.useMemo(() => {
        const d = res.json ? (res.json.data ?? res.json) : null
        const arr = Array.isArray(d)
            ? d
            : d && typeof d === "object"
              ? Object.values(d).find((v) => Array.isArray(v)) || []
              : []
        const out: { id: string; label: string; m: any }[] = []
        PROD_TABS.forEach((t) => {
            const m = pickMetric(arr as any[], t)
            if (m) out.push({ id: t.id, label: t.label, m })
        })
        return out
    }, [res.json])
    const cur = metrics.find((x) => x.id === tab) || metrics[0]
    const calc = React.useMemo(() => {
        if (!cur) return null
        const m = cur.m
        const vals: { iso: string; v: number; y: number }[] = []
        let world: number | null = null
        Object.keys(m.values).forEach((k) => {
            const a = m.values[k]
            if (!Array.isArray(a) || !a.length) return
            const pts = a
                .map((p: any) => ({
                    y: num(p && (p.year ?? p.date)),
                    v: num(p && p.value),
                }))
                .filter((p: any) => p.y !== null && p.v !== null)
                .sort((p: any, q: any) => p.y - q.y)
            const l = pts[pts.length - 1]
            if (!l) return
            const iso = k.toUpperCase()
            if (iso === "WLD" || iso === "WORLD") {
                world = l.v
                return
            }
            if (!ISO_ALL.has(iso)) return
            vals.push({ iso, v: l.v as number, y: l.y as number })
        })
        const maxY = Math.max(0, ...vals.map((x) => x.y))
        const rep = vals.filter((x) => x.v > 0)
        const total = world ?? rep.reduce((a, b) => a + b.v, 0)
        const sorted = rep.sort((a, b) => b.v - a.v)
        return {
            m,
            sorted,
            total,
            maxY,
            n: rep.filter((x) => x.y === maxY).length,
        }
    }, [cur])
    const wait = gate(res, "producers")
    let shown: { r: number; iso: string; v: number }[] = []
    if (calc) {
        shown = calc.sorted
            .slice(0, ctx.producerRows)
            .map((x, i) => ({ r: i + 1, iso: x.iso, v: x.v }))
        const si = calc.sorted.findIndex((x) => x.iso === ctx.selected)
        if (si >= ctx.producerRows)
            shown.push({ r: si + 1, iso: ctx.selected, v: calc.sorted[si].v })
    }
    const max = calc && calc.sorted.length ? calc.sorted[0].v : 1
    const dec = calc && isNum(calc.m.decimals) ? calc.m.decimals : 1
    return (
        <section className="hx-card xp-card" aria-label="World producers">
            <div className="hx-h hx-between">
                <h2 className="hx-t">World producers</h2>
                {metrics.length > 1 ? (
                    <div className="hx-pills" role="group" aria-label="Fuel">
                        {metrics.map((x) => (
                            <button
                                key={x.id}
                                className="hx-pill"
                                aria-pressed={cur && cur.id === x.id}
                                onClick={() => setTab(x.id)}
                            >
                                {x.label}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            {wait ? (
                wait
            ) : !calc || !shown.length ? (
                <Empty json={res.json} />
            ) : (
                <>
                    <div className="xp-prod">
                        {shown.map((x) => (
                            <button
                                key={x.iso}
                                className={
                                    "xp-prow" +
                                    (x.iso === ctx.selected ? " on" : "")
                                }
                                onClick={() => ctx.onSelect(x.iso)}
                            >
                                <span className="xp-rk">{x.r}</span>
                                <span className="xp-pn">
                                    {ISO3_2[x.iso] ? (
                                        <img
                                            src={`https://flagcdn.com/w40/${ISO3_2[x.iso].toLowerCase()}.png`}
                                            alt=""
                                            width="18"
                                            height="12"
                                        />
                                    ) : null}
                                    <span className="xp-ell">
                                        {regionName(x.iso)}
                                    </span>
                                </span>
                                <span className="xp-track">
                                    <i
                                        style={{
                                            width:
                                                Math.max(1, (x.v / max) * 100) +
                                                "%",
                                        }}
                                    />
                                </span>
                                <b>{vfmt(x.v, dec)}</b>
                                <em>
                                    {calc.total
                                        ? nf((x.v / calc.total) * 100, 1) + "%"
                                        : ""}
                                </em>
                            </button>
                        ))}
                    </div>
                    <p className="xp-note">
                        {[
                            String(calc.m.name || calc.m.id),
                            calc.m.unit ? String(calc.m.unit) : "",
                        ]
                            .filter(Boolean)
                            .join(", ") +
                            "; share of world total. Latest reported year (" +
                            calc.maxY +
                            "). " +
                            calc.n +
                            " countries report. Source: " +
                            srcName(res.json, "US EIA") +
                            "."}
                    </p>
                </>
            )}
        </section>
    )
}

/* ---- US fundamentals (EIA weekly) ---- */

const wdec = (v: number) =>
    Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3

function UsWeeklyX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/eiaweekly.json", ctx.refreshMs)
    const rows = React.useMemo(() => {
        if (!res.json) return []
        return collect(res.json.data ?? res.json)
            .map(([k, x]) => {
                const row = toRow([k, x])
                if (!row || row.value === null) return null
                const p = toPts(x)
                return {
                    label: row.label,
                    sub: [row.unit, row.sub].filter(Boolean).join(" · "),
                    v: row.value as number,
                    chg: row.change,
                    s: thin(sliceRange(p, 366), 60).map((q) => q.v),
                }
            })
            .filter((r): r is NonNullable<typeof r> => !!r)
            .slice(0, ctx.rows)
    }, [res.json, ctx.rows])
    const wait = gate(res, "US fundamentals")
    return (
        <XCard
            title="US fundamentals"
            meta={"Weekly · " + srcName(res.json, "US EIA")}
        >
            {wait ? (
                wait
            ) : !rows.length ? (
                <Empty json={res.json} />
            ) : (
                <table className="xp-tbl">
                    <thead>
                        <tr>
                            <th>Series</th>
                            <th className="xp-n">Latest</th>
                            <th className="xp-n">Week</th>
                            <th className="xp-n xp-spark">1Y</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.label}>
                                <td className="xp-l">
                                    {r.label}
                                    {r.sub ? <small>{r.sub}</small> : null}
                                </td>
                                <td className="xp-n">{nf(r.v, wdec(r.v))}</td>
                                <td className={"xp-n " + dir(r.chg)}>
                                    {r.chg === null
                                        ? ""
                                        : (r.chg > 0
                                              ? "▲ "
                                              : r.chg < 0
                                                ? "▼ "
                                                : "") +
                                          nf(Math.abs(r.chg), wdec(r.v))}
                                </td>
                                <td className="xp-spark">
                                    {r.s.length > 2 ? (
                                        <Line pts={r.s} h={20} />
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </XCard>
    )
}

/* ---- Release calendar (usual schedules + events.json) ---- */

type Rel = {
    title: string
    src: string
    days: number[] // 0 = Sunday
    h: number
    m: number
    tz: string
}
// Usual publication times, in the publisher's own time zone
const RELEASES: Rel[] = [
    {
        title: "US Weekly Petroleum Status Report",
        src: "US EIA",
        days: [3],
        h: 10,
        m: 30,
        tz: "America/New_York",
    },
    {
        title: "US Natural Gas Storage Report",
        src: "US EIA",
        days: [4],
        h: 10,
        m: 30,
        tz: "America/New_York",
    },
    {
        title: "North America rig count",
        src: "Baker Hughes",
        days: [5],
        h: 13,
        m: 0,
        tz: "America/New_York",
    },
    {
        title: "US retail gasoline and diesel prices",
        src: "US EIA",
        days: [1],
        h: 17,
        m: 0,
        tz: "America/New_York",
    },
]
const BRIEF_DAYS = [0, 3] // Sunday and Wednesday, 07:00 in the calendar time zone

function tzOffset(t: number, tz: string): number {
    const p = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(t))
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value || 0)
    const asUtc = Date.UTC(
        g("year"),
        g("month") - 1,
        g("day"),
        g("hour") % 24,
        g("minute"),
        g("second")
    )
    return (asUtc - t) / 60000
}
function zoned(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    tz: string
) {
    const guess = Date.UTC(y, mo, d, h, mi)
    try {
        const off = tzOffset(guess, tz)
        let t = guess - off * 60000
        const off2 = tzOffset(t, tz)
        if (off2 !== off) t = guess - off2 * 60000
        return t
    } catch {
        return guess
    }
}

function CalendarX({ ctx }: { ctx: XCtx }) {
    const ev = usePanel(ctx.base, "/api/v1/events.json", ctx.refreshMs * 6)
    const [now, setNow] = React.useState(() => Date.now())
    React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60000)
        return () => clearInterval(id)
    }, [])
    const tz = ctx.calTz || "UTC"
    const fmt = React.useMemo(() => {
        const mk = (o: any) => {
            try {
                return new Intl.DateTimeFormat("en-GB", { ...o, timeZone: tz })
            } catch {
                return new Intl.DateTimeFormat("en-GB", {
                    ...o,
                    timeZone: "UTC",
                })
            }
        }
        return {
            day: mk({ weekday: "short", day: "numeric" }),
            time: mk({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
        }
    }, [tz])
    const items = React.useMemo(() => {
        const rels: Rel[] = [...RELEASES]
        if (ctx.briefTitle)
            rels.push({
                title: ctx.briefTitle,
                src: "Economic Bearings",
                days: BRIEF_DAYS,
                h: 7,
                m: 0,
                tz,
            })
        const out: {
            t: number
            title: string
            src: string
            url?: string
            allDay?: boolean
        }[] = []
        for (let i = -1; i < 22; i++) {
            const d = new Date(now + i * 864e5)
            const y = d.getUTCFullYear()
            const mo = d.getUTCMonth()
            const da = d.getUTCDate()
            const wd = new Date(Date.UTC(y, mo, da)).getUTCDay()
            rels.forEach((r) => {
                if (!r.days.includes(wd)) return
                const t = zoned(y, mo, da, r.h, r.m, r.tz)
                if (t >= now - 3600e3)
                    out.push({ t, title: r.title, src: r.src })
            })
        }
        if (ev.json)
            eventItems(ev.json.data ?? ev.json).forEach((e) => {
                const t = toDate(e.date)
                if (t === null || t < now - 3600e3 || t > now + 22 * 864e5)
                    return
                out.push({
                    t,
                    title: e.title,
                    src: e.loc || "Event",
                    url: e.url,
                    allDay: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)),
                })
            })
        const seen = new Set<string>()
        return out
            .sort((a, b) => a.t - b.t)
            .filter((x) => {
                const k = x.title + x.t
                if (seen.has(k)) return false
                seen.add(k)
                return true
            })
            .slice(0, ctx.calendarRows)
    }, [now, ev.json, ctx.briefTitle, ctx.calendarRows, tz])
    return (
        <XCard
            title="Release calendar"
            meta={ctx.calTzLabel}
            foot="Usual schedules; public holidays can move a release by a day."
        >
            <ul className="xp-cal">
                {items.map((x, i) => (
                    <li
                        key={x.title + x.t}
                        className={
                            (i === 0 ? "next " : "") +
                            (x.src === "Economic Bearings" ? "ceii" : "")
                        }
                    >
                        <time dateTime={new Date(x.t).toISOString()}>
                            {fmt.day.format(new Date(x.t))}
                            <small>
                                {x.allDay ? "" : fmt.time.format(new Date(x.t))}
                            </small>
                        </time>
                        <span>
                            {x.url ? (
                                <a
                                    href={x.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {x.title}
                                </a>
                            ) : (
                                <b>{x.title}</b>
                            )}
                            <small>{x.src}</small>
                        </span>
                    </li>
                ))}
            </ul>
        </XCard>
    )
}

/* ---- World energy (World Bank, world aggregate) ---- */

type Cand = { label: string; v: number; y: number; unit?: string }

function worldCands(data: any): Cand[] {
    const out: Cand[] = []
    const W: Country = { iso3: "WLD", name: "World" }
    if (
        Array.isArray(data) &&
        data.some((m) => m && m.values && typeof m.values === "object")
    ) {
        data.forEach((m: any) => {
            const a =
                m &&
                m.values &&
                (m.values.WLD || m.values.World || m.values.world)
            if (!Array.isArray(a)) return
            const pts = a
                .map((p: any) => ({
                    y: num(p && (p.year ?? p.date)),
                    v: num(p && p.value),
                }))
                .filter((p: any) => p.y !== null && p.v !== null)
                .sort((p: any, q: any) => p.y - q.y)
            const l = pts[pts.length - 1]
            if (l)
                out.push({
                    label: String(m.id || "") + " " + String(m.name || ""),
                    v: l.v as number,
                    y: l.y as number,
                    unit: sv(m.unit),
                })
        })
    }
    walk(data, (item, path, _s, hint) => {
        const o = lc(item)
        if (!sameCountry(W, idOf(o, hint))) return
        const ind = sv(o.indicator) || sv(o.indicatorname) || sv(o.series) || ""
        const base = [...path.filter((p) => isNaN(Number(p))), ind].join(" ")
        const y = num(o.year ?? o.date) ?? 0
        const v = num(o.value)
        if (v !== null) out.push({ label: base, v, y, unit: sv(o.unit) })
        Object.keys(o).forEach((k) => {
            if (k === "value" || SKIP_NUM.test(k) || ID_KEYS.includes(k)) return
            const ch = o[k]
            if (isNum(ch)) out.push({ label: base + " " + k, v: ch, y })
            else if (ch && typeof ch === "object" && !Array.isArray(ch)) {
                const co = lc(ch)
                const n = pickNum(co, ["value", "latest", "v"])
                if (n !== null)
                    out.push({
                        label: base + " " + k + " " + (sv(co.name) || ""),
                        v: n,
                        y: num(co.year ?? co.date) ?? y,
                        unit: sv(co.unit),
                    })
            } else if (Array.isArray(ch)) {
                const pp = ch
                    .map((p: any) => {
                        if (!p || typeof p !== "object") return null
                        const q = lc(p)
                        return { y: num(q.year ?? q.date), v: num(q.value) }
                    })
                    .filter((p: any) => p && p.y !== null && p.v !== null)
                    .sort((p: any, q: any) => p.y - q.y)
                const l = pp[pp.length - 1]
                if (l)
                    out.push({
                        label: base + " " + k,
                        v: l.v as number,
                        y: l.y as number,
                    })
            }
        })
    })
    return out
}

const WE: {
    label: string
    re: RegExp
    pref?: RegExp
    not?: RegExp
    kind: "pct" | "co2" | "mj"
    csv?: string
}[] = [
    {
        label: "Electricity access",
        re: /access/,
        pref: /elec|elc/,
        not: /cooking|fuel|rural|urban/,
        kind: "pct",
        csv: "electricity-access",
    },
    {
        label: "Renewable electricity",
        re: /renew/,
        pref: /elec|elc|output/,
        not: /consumption|fec/,
        kind: "pct",
        csv: "renewable-electricity-share",
    },
    {
        label: "Coal in power mix",
        re: /coal/,
        pref: /elec|elc|power|mix|share/,
        kind: "pct",
    },
    {
        label: "CO₂ emissions",
        re: /co2|co₂|carbon|ghg|emission/,
        pref: /kt|mt|total|co2e/,
        not: /capita|\.pc|percap|intensity|gdp/,
        kind: "co2",
    },
    {
        label: "Energy intensity",
        re: /intensity|egy\.prim|primary energy/,
        not: /carbon|co2/,
        kind: "mj",
    },
]

function WorldEnergyX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/worldbank.json", ctx.refreshMs * 6)
    const acc = useCSV(ctx.base, "electricity-access")
    const ren = useCSV(ctx.base, "renewable-electricity-share")
    const rows = React.useMemo(() => {
        const cands = res.json ? worldCands(res.json.data ?? res.json) : []
        return WE.map((w) => {
            let best: Cand | null = null
            let bs = -1
            cands.forEach((c) => {
                const l = c.label.toLowerCase()
                if (!w.re.test(l) || (w.not && w.not.test(l))) return
                const sc = (w.pref && w.pref.test(l) ? 1e5 : 0) + c.y
                if (sc > bs) {
                    bs = sc
                    best = c
                }
            })
            let c = best as Cand | null
            if (!c && w.csv) {
                const ind = w.csv === "electricity-access" ? acc : ren
                const l = lastOf(ind?.byIso.get("WLD"))
                if (l) c = { label: w.label, v: l.v, y: l.y }
            }
            if (!c) return null
            let txt = ""
            if (w.kind === "pct") txt = nf(c.v, 1) + "%"
            else if (w.kind === "co2") {
                const kt =
                    /kt/.test((c.unit || "") + " " + c.label.toLowerCase()) ||
                    c.v > 1e6
                txt = nf(kt ? c.v / 1000 : c.v, 0) + " Mt"
            } else txt = nf(c.v, 2) + " MJ/$"
            return { label: w.label, y: c.y, txt }
        }).filter((r): r is NonNullable<typeof r> => !!r)
    }, [res.json, acc, ren])
    const wait = !rows.length ? gate(res, "world energy") : null
    return (
        <XCard title="World energy" meta={srcName(res.json, "World Bank")}>
            {wait ? (
                wait
            ) : !rows.length ? (
                <Empty json={res.json} />
            ) : (
                <div className="xp-kvs">
                    {rows.map((r) => (
                        <div className="xp-kv" key={r.label}>
                            <span>
                                {r.label}
                                {r.y ? " (" + r.y + ")" : ""}
                            </span>
                            <b>{r.txt}</b>
                        </div>
                    ))}
                </div>
            )}
        </XCard>
    )
}

/* ---- Sun today (Open-Meteo) ---- */

function SunX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/solar.json", ctx.refreshMs)
    const rows = React.useMemo(
        () =>
            res.json
                ? solarRows(res.json.data ?? res.json).slice(0, ctx.rows)
                : [],
        [res.json, ctx.rows]
    )
    const max = Math.max(1, ...rows.map((r) => r.v))
    const wait = gate(res, "solar forecast")
    return (
        <XCard
            title="Sun today"
            meta={"kWh/m² · " + srcName(res.json, "Open-Meteo")}
        >
            {wait ? (
                wait
            ) : !rows.length ? (
                <Empty json={res.json} />
            ) : (
                <div>
                    {rows.map((r) => (
                        <div className="xp-brow" key={r.name}>
                            <span className="xp-ell">{r.name}</span>
                            <span className="xp-track xp-acc">
                                <i
                                    style={{
                                        width:
                                            Math.max(2, (r.v / max) * 100) +
                                            "%",
                                    }}
                                />
                            </span>
                            <b title={r.sun !== null ? r.sun + " h sun" : ""}>
                                {nf(r.v, 1)}
                            </b>
                        </div>
                    ))}
                </div>
            )}
        </XCard>
    )
}

/* ---- Pump prices (retail fuel) ---- */

const PETROL_RE = /petrol|euro.?95|e10|unleaded|gasoline|super|regular/
const DIESEL_RE = /diesel/
const US_PATH = /^(us|usa|unitedstates|states|usstates|statesus)$/
const USA: Country = { iso3: "USA", iso2: "US", name: "United States" }

function pumpData(data: any) {
    const eu = new Map<string, { name: string; v: number }>()
    const states: { p: number | null; d: number | null }[] = []
    let nat: { p: number | null; d: number | null } | null = null
    const fuel = (o: Record<string, any>, re: RegExp, notRe?: RegExp) => {
        for (const k of Object.keys(o)) {
            if (!re.test(k) || (notRe && notRe.test(k))) continue
            const n = num(o[k])
            if (n !== null) return n
            if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) {
                const m = pickNum(lc(o[k]), [
                    "price",
                    "value",
                    "eur",
                    "latest",
                    "current",
                    "avg",
                ])
                if (m !== null) return m
            }
        }
        return null
    }
    walk(data, (item, path, _s, hint) => {
        const o = lc(item)
        let p = fuel(o, PETROL_RE, DIESEL_RE)
        let d = fuel(o, DIESEL_RE)
        if (p === null && d === null) {
            const f = sv(pickKey(o, ["fuel", "product", "type"]))
            const v = pickNum(o, ["price", "value"])
            if (f && v !== null) {
                if (DIESEL_RE.test(f.toLowerCase())) d = v
                else if (PETROL_RE.test(f.toLowerCase())) p = v
            }
        }
        if (p === null && d === null) return
        const id = idOf(o, hint)
        const inUS = path.some((s) => US_PATH.test(strip(s)))
        if (!inUS && sameCountry(USA, id)) {
            nat = nat || { p, d }
            return
        }
        if (inUS) {
            states.push({ p, d })
            return
        }
        if (!id.name && !id.iso) return
        if (p === null || p < 0.2 || p > 5) return
        const name =
            id.name && !/^[A-Za-z]{2,3}$/.test(id.name)
                ? id.name
                : regionName(id.iso || id.name || "")
        const key = canon(name)
        if (!eu.has(key)) eu.set(key, { name, v: p })
    })
    const avg = (a: (number | null)[]) => {
        const x = a.filter((v): v is number => v !== null)
        return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null
    }
    const n = nat as { p: number | null; d: number | null } | null
    const us = {
        p: n && n.p !== null ? n.p : avg(states.map((s) => s.p)),
        d: n && n.d !== null ? n.d : avg(states.map((s) => s.d)),
        states: !n && states.length > 0,
    }
    const list = Array.from(eu.values()).sort((a, b) => b.v - a.v)
    return { list, us }
}

function PumpX({ ctx }: { ctx: XCtx }) {
    const res = usePanel(ctx.base, "/api/v1/retailfuel.json", ctx.refreshMs)
    const pd = React.useMemo(
        () => (res.json ? pumpData(res.json.data ?? res.json) : null),
        [res.json]
    )
    const wait = gate(res, "pump prices")
    const n = ctx.pumpRows
    const hi = pd ? pd.list.slice(0, n) : []
    const lo = pd ? pd.list.slice(-n).reverse() : []
    return (
        <XCard title="Pump prices" meta="Petrol · weekly">
            {wait ? (
                wait
            ) : !pd || (!pd.list.length && pd.us.p === null) ? (
                <Empty json={res.json} />
            ) : (
                <>
                    {pd.list.length > 0 && (
                        <div className="xp-pump">
                            <div>
                                <p className="xp-cap">
                                    Europe, highest (€/litre)
                                </p>
                                {hi.map((r) => (
                                    <div className="xp-kv" key={r.name}>
                                        <span>{r.name}</span>
                                        <b>{nf(r.v, 2)}</b>
                                    </div>
                                ))}
                            </div>
                            <div>
                                <p className="xp-cap">
                                    Europe, lowest (€/litre)
                                </p>
                                {lo.map((r) => (
                                    <div className="xp-kv" key={r.name}>
                                        <span>{r.name}</span>
                                        <b>{nf(r.v, 2)}</b>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {pd.us.p !== null && (
                        <div className="xp-us">
                            <span>
                                United States
                                {pd.us.states ? ", average of states" : ""}{" "}
                                (US$/gallon)
                            </span>
                            <b>
                                {nf(pd.us.p, 2)}
                                {pd.us.d !== null
                                    ? " · diesel " + nf(pd.us.d, 2)
                                    : ""}
                            </b>
                        </div>
                    )}
                </>
            )}
        </XCard>
    )
}

/* ---- Layout of the extra panels ----
 * masonry : each panel drops into the shortest column, so short panels fill the
 *           gaps next to long ones; list order is kept left to right.
 * rows    : panels side by side, every card in a row stretched to the same height.
 * grid    : plain grid, cards top-aligned (the original behaviour).
 * Full-width panels always start a new band across all columns.
 */
const GAP = 14

type GridItem = { id: string; wide: boolean; node: React.ReactNode }

function XGrid({
    items: list,
    minW,
    layout,
    cardHeight = 0,
}: {
    items: GridItem[]
    minW: number
    layout: string
    cardHeight?: number
}) {
    const ids = list.map((x) => x.id)
    const wideOf = (id: string) => !!list.find((x) => x.id === id)?.wide
    const wrap = React.useRef<HTMLDivElement>(null)
    const items = React.useRef(new Map<string, HTMLDivElement>())
    const [w, setW] = React.useState(0)
    const [hs, setHs] = React.useState<Record<string, number>>({})
    const masonry = layout === "masonry"

    React.useEffect(() => {
        if (!masonry || typeof ResizeObserver === "undefined") return
        const ro = new ResizeObserver((entries) => {
            const next: Record<string, number> = {}
            let width = -1
            entries.forEach((e) => {
                const el = e.target as HTMLElement
                if (el === wrap.current) width = el.clientWidth
                else if (el.dataset.xid) next[el.dataset.xid] = el.offsetHeight
            })
            if (width >= 0) setW(width)
            if (Object.keys(next).length)
                setHs((p) => {
                    for (const k in next)
                        if (p[k] !== next[k]) return { ...p, ...next }
                    return p
                })
        })
        if (wrap.current) ro.observe(wrap.current)
        items.current.forEach((el) => ro.observe(el))
        return () => ro.disconnect()
    }, [masonry, ids.join("|")])

    const ready = masonry && w > 0 && ids.every((id) => hs[id] > 0)
    let pos: Record<string, React.CSSProperties> = {}
    let height = 0
    if (ready) {
        const cols = Math.max(1, Math.floor((w + GAP) / (minW + GAP)))
        const cw = (w - GAP * (cols - 1)) / cols
        const colH = new Array(cols).fill(0)
        ids.forEach((id) => {
            if (wideOf(id) || cols === 1) {
                const y = Math.max(...colH)
                pos[id] = { top: y, left: 0, width: w }
                colH.fill(y + hs[id] + GAP)
            } else {
                let c = 0
                colH.forEach((h, i) => {
                    if (h < colH[c] - 1) c = i
                })
                pos[id] = { top: colH[c], left: c * (cw + GAP), width: cw }
                colH[c] += hs[id] + GAP
            }
        })
        height = Math.max(0, Math.max(...colH) - GAP)
    }

    return (
        <div
            ref={wrap}
            className={
                "xp-grid" +
                (layout === "rows" ? " xp-rows" : "") +
                (ready ? " xp-mas" : "")
            }
            style={
                ready
                    ? { height }
                    : masonry
                      ? { visibility: "hidden" }
                      : undefined
            }
        >
            {list.map(({ id, wide, node }) => (
                <div
                    key={id}
                    data-xid={id}
                    ref={(el) => {
                        if (el) items.current.set(id, el)
                        else items.current.delete(id)
                    }}
                    className={
                        wide ? "xp-wide" : cardHeight > 0 ? "xp-fixed" : ""
                    }
                    style={
                        ready
                            ? pos[id]
                            : !wide && cardHeight > 0
                              ? { height: cardHeight }
                              : undefined
                    }
                >
                    {node}
                </div>
            ))}
        </div>
    )
}

function XPanel({ id, ctx }: { id: XId; ctx: XCtx }) {
    switch (id) {
        case "signals":
            return <SignalsX ctx={ctx} />
        case "commodities":
            return <CommoditiesX ctx={ctx} />
        case "equities":
            return <EquitiesX ctx={ctx} />
        case "powerhours":
            return <PowerHoursX ctx={ctx} />
        case "producers":
            return <ProducersX ctx={ctx} />
        case "usweekly":
            return <UsWeeklyX ctx={ctx} />
        case "calendar":
            return <CalendarX ctx={ctx} />
        case "worldenergy":
            return <WorldEnergyX ctx={ctx} />
        case "sun":
            return <SunX ctx={ctx} />
        case "pump":
            return <PumpX ctx={ctx} />
        default:
            return null
    }
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/* Fonts: loaded once in <head> (not via @import inside the component),
   and the terminal fades in only when they are ready -> no flash of the fallback design. */
const FONT_HREF =
    "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
const FONT_FACES = [
    '600 16px "Playfair Display"',
    '400 14px "Instrument Sans"',
    '500 13px "JetBrains Mono"',
]
let fontsPromise: Promise<void> | null = null

function fontsReady(): Promise<void> {
    if (typeof document === "undefined") return Promise.resolve()
    if (fontsPromise) return fontsPromise
    fontsPromise = new Promise<void>((resolve) => {
        const fonts = (document as any).fonts
        const loadFaces = () => {
            if (!fonts || !fonts.load) return resolve()
            Promise.all(FONT_FACES.map((f) => fonts.load(f).catch(() => null)))
                .then(() => resolve())
                .catch(() => resolve())
        }
        const head = document.head || document.documentElement
        const already = Array.from(
            document.querySelectorAll('link[rel="stylesheet"]')
        ).find(
            (l) => (l as HTMLLinkElement).href.indexOf("Instrument+Sans") !== -1
        ) as HTMLLinkElement | undefined
        let link = already || null
        if (!link) {
            ;[
                "https://fonts.googleapis.com",
                "https://fonts.gstatic.com",
            ].forEach((h) => {
                const p = document.createElement("link")
                p.rel = "preconnect"
                p.href = h
                if (h.indexOf("gstatic") !== -1) p.crossOrigin = "anonymous"
                head.appendChild(p)
            })
            link = document.createElement("link")
            link.rel = "stylesheet"
            link.href = FONT_HREF
            link.setAttribute("data-cet-fonts", "")
            head.appendChild(link)
        }
        if (link.sheet) loadFaces()
        else {
            link.addEventListener("load", loadFaces)
            link.addEventListener("error", () => resolve())
        }
    })
    return fontsPromise
}
// start loading as soon as the code file is evaluated
if (typeof document !== "undefined") fontsReady()

const CSS = `
.cet{background:var(--bg);color:var(--ink);font:400 14px/1.4 var(--fb);font-variant-numeric:tabular-nums;padding:22px clamp(12px,2.2vw,28px) 22px;width:100%}
.cet *{box-sizing:border-box}
.cet h1{font:600 clamp(30px,4.2vw,46px)/1.1 var(--fh);text-align:center;margin:0 0 6px}
.cet-sub{text-align:center;color:var(--mute);font-size:13px;margin:0 0 22px}
.cet .up{color:var(--up)} .cet .dn{color:var(--dn)}
.cet-tick{display:flex;background:var(--tkbg);color:var(--tktx);margin-bottom:18px;overflow:hidden;border-radius:6px}
.cet-sticky{position:-webkit-sticky;position:sticky;top:var(--tktop,0px);z-index:5;box-shadow:0 6px 16px rgba(30,22,20,.14);transition:opacity .2s ease}
.cet-gone{opacity:0;pointer-events:none}
.cet-tl{flex:none;background:var(--tlbg);color:var(--tltx);padding:9px 16px;font:500 14px var(--fh)}
.cet-win{flex:1;overflow:hidden;min-width:0}
.cet-track{display:inline-flex;white-space:nowrap;animation:cet-s 60s linear infinite}
.cet-tick:hover .cet-track{animation-play-state:paused}
@keyframes cet-s{to{transform:translateX(-50%)}}
.cet-ti{display:inline-flex;gap:8px;align-items:baseline;padding:9px 22px;border-right:1px solid rgba(255,255,255,.14);font-size:13px}
.cet-ti b{font-weight:500;color:var(--tkname)}
.cet-ti em{font-style:normal}
.cet-tick .up{color:var(--tkup)} .cet-tick .dn{color:var(--tkdn)}
.cet-cmd{display:flex;gap:12px;align-items:stretch;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}
.cet-in{flex:1 1 260px;max-width:420px;background:var(--hd);border:1px solid var(--rule);border-radius:6px;padding:9px 12px;font:inherit;color:var(--ink)}
.cet-in::placeholder{color:var(--mute)}
.cet-in:focus-visible,.cet-tab:focus-visible,.cet a:focus-visible,.cet summary:focus-visible,.cet button:focus-visible,.cet select:focus-visible,.hx-c:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.cet-tabs{display:flex;gap:6px;overflow-x:auto;max-width:100%}
.cet-tab{background:transparent;border:1px solid var(--rule);border-radius:4px;padding:8px 14px;font:500 13px var(--fb);color:var(--ink);cursor:pointer;white-space:nowrap}
.cet-tab[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
.cet-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,430px),1fr));gap:22px 28px;align-items:start}
.cet-wide{grid-column:1/-1}
.cet-panel{min-width:0;display:flex;flex-direction:column;background:var(--hd);border:1px solid var(--rule);border-radius:10px;padding:4px 0 10px}
.cet-ph{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 14px}
.cet-ph h2{margin:0;font:700 16px var(--fh);display:flex;align-items:center;gap:10px}
.cet-code{font:600 11px var(--fb);background:var(--acc);color:#fff;padding:2px 6px;letter-spacing:.04em}
.cet-stamp{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--mute);white-space:nowrap}
.cet-led{width:8px;height:8px;border-radius:50%;background:#B9AFA5;display:inline-block}
.cet-led.ok{background:var(--up)} .cet-led.warn{background:#E0A030} .cet-led.bad{background:var(--dn)}
.cet-body{padding:6px 14px 4px}
.cet-t{width:100%;border-collapse:collapse}
.cet-t th{font:400 11px var(--fb);color:var(--mute);text-transform:uppercase;letter-spacing:.05em;padding:8px 0 6px;text-align:left}
.cet-t td{padding:7px 0;border-bottom:1px solid var(--rule);font-size:15px}
.cet-t tr:last-child td{border-bottom:0}
.cet-n{text-align:right!important;padding-left:14px!important;white-space:nowrap}
.cet-t td small,.cet-news small,.cet-bv small{display:block;color:var(--mute);font-size:12px;line-height:1.3}
.cet-bv small{display:inline}
.cet-spark{width:60px;height:18px;vertical-align:middle}
.cet-pf{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 14px 0;font-size:11.5px;color:var(--mute);border-top:1px solid var(--rule);margin:6px 0 0}
.cet-load,.cet-err,.cet-empty p{color:var(--mute);margin:14px 0;font-size:13px}
.cet-err{color:var(--dn)}
.cet-empty pre{max-height:180px;overflow:auto;background:var(--bg);padding:8px;font-size:11px}
.cet-empty summary{cursor:pointer;color:var(--link);font-size:13px}
.cet-news{list-style:none;margin:0;padding:0}
.cet-news li{padding:9px 0;border-bottom:1px solid var(--rule)}
.cet-news li:last-child{border-bottom:0}
.cet-news a,.cet-evt a{color:var(--ink);text-decoration:none;font-weight:500}
.cet-news a:hover{color:var(--link);text-decoration:underline}
.cet-evt li{display:grid;grid-template-columns:78px 1fr;gap:12px}
.cet-evt time{color:var(--acc);font-weight:600;font-size:13px}
.cet-range{display:flex;flex-wrap:wrap;gap:6px 24px;padding:10px 0 8px;font-size:13px}
.cet-range em{font-style:normal;font-weight:600}
.cet-mute{color:var(--mute);margin-left:auto}
.cet-pwr{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:0 36px}
.cet-prow,.cet-brow{display:grid;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--rule)}
.cet-prow{grid-template-columns:minmax(80px,120px) 1fr 62px}
.cet-brow{grid-template-columns:minmax(90px,170px) 1fr minmax(70px,auto)}
.cet-pl,.cet-bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cet-pv,.cet-bv{text-align:right;font-weight:500}
.cet-heat{display:flex;height:18px;gap:1px}
.cet-heat i{flex:1;background:var(--heat)}
.cet-bar{display:block;height:8px;background:var(--rule)}
.cet-bar i{display:block;height:100%;background:var(--heat)}
.cet-bars{display:block}
.cet-foot{margin-top:26px;text-align:center;color:var(--mute);font-size:12px}
.cet-none{text-align:center;color:var(--mute);padding:40px 0}

/* dashboard */
.hx{display:grid;grid-template-columns:minmax(0,1.72fr) minmax(0,1fr);grid-template-areas:"bench fx" "world country" "hl country";gap:14px;align-items:stretch;margin-bottom:26px}
.hx>div{min-width:0}
/* equal heights on the overview: each card fills its grid area */
.hx>div>section,.hx-hl>section{height:100%}
.hx-fx,.hx-country,.hx-world,.hx-bench{display:flex;flex-direction:column}
.hx-fx .hx-tbl{flex:1}
.hx-fx .hx-tbl tbody td{vertical-align:middle}
.hx-fx>.hx-src,.hx-country>.hx-src:last-child,.hx-bench>.hx-src{margin-top:auto;padding-top:8px}
.hx-world .hx-mapwrap{flex:1;display:flex;align-items:center}
.hx-world .hx-map{flex:1}
.hx-card{background:var(--hd);border:1px solid var(--rule);border-radius:10px;padding:14px 16px 10px;min-width:0}
.hx-h{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;margin-bottom:12px}
.hx-between{justify-content:space-between}
.hx-right{margin-left:auto}
.hx-t{font:700 19px/1.2 var(--fh);margin:0;padding-left:10px;border-left:3px solid var(--acc);color:var(--hc)}
.hx-t.red{color:var(--hcr)}
.hx-t2{font:700 17px var(--fh);margin:0}
.hx-pills{display:flex;gap:6px;flex-wrap:wrap}
.hx-pill{border:1px solid var(--rule);background:transparent;color:var(--ink);border-radius:3px;padding:5px 11px;font:500 12px var(--fb);cursor:pointer;white-space:nowrap}
.hx-pill:hover{border-color:var(--acc)}
.hx-pill{position:relative;overflow:hidden}
.hx-prog{position:absolute;left:0;bottom:0;height:2px;width:0;background:rgba(255,255,255,.8);animation:hx-prog 8s linear forwards}
@keyframes hx-prog{from{width:0}to{width:100%}}
@media (prefers-reduced-motion:reduce){.hx-prog{display:none}}
.hx-pill[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
.hx-mute{color:var(--mute);font-size:12px}
.hx-src{margin:8px 0 0;font-size:11px;color:var(--mute)}
.hx-price{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;margin:4px 0 12px;font-size:15px}
.hx-big{font:700 36px/1 var(--fh);margin-right:4px}
.hx-link{margin-left:auto;color:var(--acc);font-weight:600;font-size:13px;text-decoration:none}
.hx-link:hover{text-decoration:underline}
.hx-chartwrap{position:relative;padding-bottom:22px;margin-right:62px}
.hx-chart{position:relative;height:250px;border:1px solid var(--rule);background:rgba(255,255,255,.35);cursor:crosshair}
.hx-chart svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.hx-yl{position:absolute;left:100%;top:0;bottom:0;margin-left:8px;width:56px;font:500 12px var(--fb);pointer-events:none}
.hx-yl span{position:absolute;transform:translateY(-50%)}
.hx-xl{position:absolute;left:0;right:0;bottom:0;height:18px;font:500 12px var(--fb)}
.hx-xl span{position:absolute;top:4px;white-space:nowrap}
.hx-tip{position:absolute;top:8px;background:var(--ink);color:#fff;padding:5px 8px;font-size:12px;border-radius:4px;pointer-events:none;white-space:nowrap}
.hx-tip small{display:block;opacity:.7;font-size:11px}
.hx-tbl{width:100%;border-collapse:collapse;font:500 13px var(--fm)}
.hx-tbl th{font:500 11px var(--fm);color:var(--mute);text-align:left;padding:2px 0 8px}
.hx-tbl td{padding:5px 0}
.hx-tbl th.hx-n,.hx-tbl td.hx-n{text-align:right;padding-left:12px;white-space:nowrap}
.hx-tbl td.hx-sp{width:110px;padding-left:16px}
.hx-line{width:100%;display:block;color:var(--acc)}
.hx-mapwrap{position:relative}
.hx-map{width:100%;height:auto;display:block;overflow:hidden;shape-rendering:geometricPrecision}
.hx-mtip{position:absolute;z-index:3;pointer-events:none;background:var(--ink);color:#fff;border-radius:6px;padding:7px 10px;font-size:12px;line-height:1.35;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.22)}
.hx-mtip b{display:block;font-weight:600;font-size:13px}
.hx-mtip span{display:block;opacity:.7;font-size:11px}
.hx-mtip em{display:block;font-style:normal;font:600 13px var(--fm);margin-top:2px}
.hx-c{stroke:#fff;stroke-width:.7px;vector-effect:non-scaling-stroke;stroke-linejoin:round;transition:filter .12s}
.hx-c.ok{cursor:pointer}
.hx-c.ok:hover{filter:brightness(.92)}
.hx-legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11.5px;color:var(--mute);margin:6px 0 2px}
.hx-legend span{display:inline-flex;align-items:center;gap:6px}
.hx-legend i{width:12px;height:12px;display:inline-block;border-radius:2px}
.hx-hl{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.hx-rank{list-style:none;margin:0;padding:0}
.hx-rank li{border-bottom:1px solid var(--rule)}
.hx-rank li:last-child{border-bottom:0}
.hx-rank button{display:grid;grid-template-columns:26px 1fr auto;gap:8px;width:100%;background:none;border:0;padding:7px 2px;font:500 14px var(--fb);color:var(--ink);text-align:left;cursor:pointer}
.hx-rank button:hover,.hx-rank button.on{background:rgba(155,10,20,.06)}
.hx-rv{font-family:var(--fm);font-weight:500}
.hx-rn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hx-sel select{background:var(--hd);border:1px solid var(--rule);border-radius:5px;padding:6px 10px;font:500 12.5px var(--fb);color:var(--ink);max-width:180px}
.hx-vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.hx-chead{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.hx-flag{width:40px;height:28px;object-fit:cover;border:1px solid var(--rule);display:inline-block;background:#E7DDD5}
.hx-cname{font:700 19px/1.15 var(--fh);margin:0}
.hx-meta{margin:2px 0 0;font-size:11.5px;color:var(--mute)}
.hx-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}
.hx-tile{border:1px solid var(--rule);border-radius:6px;padding:8px 10px;min-width:0}
.hx-tile small{display:block;font-size:11px;color:var(--mute)}
.hx-tile b{display:block;font:600 15px var(--fm);margin:2px 0}
.hx-tile em{display:block;font-style:normal;font-size:10.5px;color:var(--mute)}
.hx-cap{font-size:11.5px;color:var(--ink);margin:12px 0 5px}
.hx-eia{width:100%;border-collapse:collapse;font:400 11.5px var(--fm)}
.hx-eia td{padding:3px 0;border-bottom:1px solid var(--rule)}
.hx-eia td.hx-n{text-align:right;padding-left:10px;white-space:nowrap}
.hx-sp2{width:48px;padding-left:8px!important}
.hx-mix{display:flex;height:22px;overflow:hidden;border-radius:2px}
.hx-mix span{display:flex;align-items:center;justify-content:center;font:600 11px var(--fm);min-width:2px}
.hx-legend2{font-size:11px;color:var(--mute);margin:5px 0 0}
.hx-minis{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px;margin-top:14px}
.hx-mini{font-size:11.5px;min-width:0}
.hx-mini span{display:block;margin-bottom:3px}
.hx-mini b{font:600 12px var(--fm);margin-left:4px}
.hx-sun{display:block;margin:6px 0 0!important;font-size:14px!important}
/* Country panel: two line colours */
.hx-country .hx-eia .hx-line,.hx-country>.hx-line,.hx-minis>:nth-child(1) .hx-line{color:var(--cl1)}
.hx-minis>:nth-child(2) .hx-line,.hx-minis>:nth-child(3) .hx-line{color:var(--cl2)}
.hx-country .hx-line path{stroke-width:1.6px}

/* extra panels */
.xp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--xmin,360px)),1fr));gap:14px;align-items:start;margin-bottom:26px}
.xp-grid>div{min-width:0}
.xp-wide{grid-column:1/-1}
.xp-rows{align-items:stretch}
.xp-rows>div>section{height:100%}
.xp-fixed>section{height:100%;overflow:auto;scrollbar-width:thin}
.xp-grid.xp-mas{display:block;position:relative}
.xp-mas>div{position:absolute;transition:top .25s ease,left .25s ease}
@media (prefers-reduced-motion:reduce){.xp-mas>div{transition:none}}
.cet-solo{padding:0!important;background:transparent!important}
.xp-tbl{width:100%;border-collapse:collapse}
.xp-tbl th{font:500 11px var(--fb);color:var(--mute);text-align:left;padding:0 0 7px;border-bottom:1px solid var(--rule)}
.xp-tbl td{padding:8px 0;border-bottom:1px solid var(--rule);vertical-align:middle}
.xp-tbl tr:last-child td{border-bottom:0}
.xp-tbl .xp-n{text-align:right;padding-left:12px;white-space:nowrap;font:500 13px var(--fm)}
.xp-tbl th.xp-n{font:500 11px var(--fb)}
.xp-l{font:500 14px var(--fb);min-width:0}
.xp-l small{display:block;font:400 11px var(--fb);color:var(--mute);margin-top:2px}
.xp-spark{width:96px;padding-left:16px!important}
.xp-sig{display:inline-block;min-width:54px;text-align:right;padding:3px 7px;border-radius:3px;font:600 13px var(--fm)}
.xp-sig.hot{background:color-mix(in srgb,var(--acc) 12%,transparent);color:var(--acc)}
.xp-note{font-size:11px;color:var(--mute);margin:10px 0 0}
.xp-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.xp-track{display:block;height:6px;background:var(--rule);border-radius:3px;overflow:hidden}
.xp-track i{display:block;height:100%;background:var(--mute);border-radius:3px}
.xp-acc i,.xp-prow.on .xp-track i{background:var(--acc)}
.xp-ph{columns:2 420px;column-gap:36px}
.xp-phr{display:grid;grid-template-columns:minmax(80px,130px) 1fr 52px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--rule);break-inside:avoid;font-size:13px}
.xp-phr b{font:500 12.5px var(--fm);text-align:right}
.xp-cells{display:grid;grid-template-columns:repeat(24,minmax(0,1fr));gap:1px;height:16px}
.xp-cells i{background:var(--heat)}
.xp-prow{display:grid;grid-template-columns:24px minmax(100px,170px) 1fr 60px 50px;gap:10px;align-items:center;width:100%;background:none;border:0;border-bottom:1px solid var(--rule);padding:6px 4px;font:500 14px var(--fb);color:var(--ink);text-align:left;cursor:pointer}
.xp-prow:hover,.xp-prow.on{background:color-mix(in srgb,var(--acc) 7%,transparent)}
.xp-prow .xp-rk{color:var(--mute);font:500 12px var(--fm);text-align:right}
.xp-prow b{font:600 13px var(--fm);text-align:right}
.xp-prow em{font:400 12px var(--fm);font-style:normal;color:var(--mute);text-align:right}
.xp-pn{display:flex;align-items:center;gap:7px;min-width:0}
.xp-pn img{width:18px;height:12px;object-fit:cover;flex:none;border:1px solid var(--rule)}
.xp-cal{list-style:none;margin:0;padding:0}
.xp-cal li{display:grid;grid-template-columns:70px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--rule)}
.xp-cal li:last-child{border-bottom:0}
.xp-cal time{font:600 12.5px var(--fm)}
.xp-cal time small{display:block;font-weight:400;color:var(--mute);margin-top:2px}
.xp-cal li.next time{color:var(--acc)}
.xp-cal b,.xp-cal a{display:block;font:500 14px var(--fb);color:var(--ink);text-decoration:none}
.xp-cal a:hover{color:var(--link);text-decoration:underline}
.xp-cal span small{display:block;color:var(--mute);font-size:11.5px;margin-top:2px}
.xp-cal li.ceii span small{color:var(--acc)}
.xp-kv{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--rule);font-size:14px}
.xp-kv b{font:600 13px var(--fm)}
.xp-kvs .xp-kv:last-child{border-bottom:0}
.xp-brow{display:grid;grid-template-columns:minmax(90px,130px) 1fr 44px;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--rule);font-size:14px}
.xp-brow b{font:600 13px var(--fm);text-align:right}
.xp-pump{display:grid;grid-template-columns:1fr 1fr;gap:0 22px}
.xp-cap{font-size:11px;color:var(--mute);margin:0 0 2px}
.xp-us{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px 12px;padding:10px 0 2px;margin-top:6px;font-size:13px}
.xp-us b{font:600 13px var(--fm)}

@media (max-width:980px){.hx{grid-template-columns:minmax(0,1fr);grid-template-areas:"bench" "fx" "world" "hl" "country"}.hx-chartwrap{margin-right:52px}}
@media (max-width:560px){.hx-hl{grid-template-columns:1fr}.hx-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.hx-link{margin-left:0}
.hx-card{padding:12px 12px 8px}
.hx-t{font-size:17px}
.hx-h{gap:8px 10px}
.hx-pill{padding:4px 8px;font-size:11.5px}
.hx-big{font-size:30px}
.hx-price{gap:4px 12px;font-size:14px}
.hx-chartwrap{margin-right:44px}
.hx-chart{height:190px}
.hx-yl{width:42px;margin-left:6px;font-size:11px}
.hx-xl{font-size:10.5px}
.hx-xl span:nth-child(even){display:none}
.hx-tip{font-size:11px}
.xp-prow{grid-template-columns:22px minmax(80px,1fr) 1fr 54px 44px;gap:8px;font-size:13px}
.xp-pump{grid-template-columns:1fr}
.xp-spark{width:64px;padding-left:10px!important}
.xp-l{font-size:13px}
}
@media (prefers-reduced-motion:reduce){.cet-win{overflow-x:auto}.cet-track{animation:none}.hx-c{transition:none}}

.cet h1{text-transform:var(--tc-title)}
.hx-t,.hx-t2,.cet-ph h2,.hx-cname{text-transform:var(--tc-head)}
.cet-ph h2,.hx-t2,.hx-cname{color:var(--hc)}
.hx-pill,.cet-tab,.hx-cap,.hx-tile small,.hx-tbl th,.xp-tbl th,.xp-cap{text-transform:var(--tc-label)}
.cet-t th{text-transform:var(--tc-th)}
.hx-link{display:none}
`

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

type Props = {
    mode: string
    tickerSticky: boolean
    tickerAutoTop: boolean
    tickerTop: number
    benchSlider: boolean
    benchSpeed: number
    worldRotate: boolean
    worldSpeed: number
    countryLine1: string
    countryLine2: string
    layout: string
    wideFirst: boolean
    cardHeight: number
    extraPanels: string[]
    widePanels: string[]
    panelMinWidth: number
    classicPanels: boolean
    maxRows: number
    signalRows: number
    producerRows: number
    calendarRows: number
    pumpRows: number
    calTz: string
    calTzLabel: string
    briefTitle: string
    title: string
    subtitle: string
    baseUrl: string
    csvBase: string
    csvProxy: string
    csvFiles: { slug: string; file?: string }[]
    debug: boolean
    footerText: string
    titleFont: any
    titleColor?: string
    titleCase: string
    titleGap: number
    titleSubGap: number
    headingFont: any
    headingColor?: string
    headingCase: string
    bodyFont: any
    dataFont: any
    labelCase: string
    mutedColor: string
    lineColor: string
    upColor: string
    downColor: string
    tickerBg: string
    tickerText: string
    tickerLabel: string
    tickerLabelBg: string
    tickerLabelText: string
    tickerName: string
    tickerUp: string
    tickerDown: string
    defaultTab: string
    defaultCountry: string
    defaultMetric: string
    showTicker: boolean
    refreshMinutes: number
    density: "comfortable" | "compact"
    background: string
    panelHeader: string
    ink: string
    accent: string
    heat: string
}

const fam = (f: any, fallback: string) =>
    f && f.fontFamily
        ? '"' + String(f.fontFamily).replace(/"/g, "") + '",' + fallback
        : ""

export default function EnergyTerminal(props: Props) {
    const {
        mode,
        tickerSticky,
        tickerAutoTop,
        tickerTop,
        benchSlider,
        benchSpeed,
        worldRotate,
        worldSpeed,
        countryLine1,
        countryLine2,
        layout,
        wideFirst,
        cardHeight,
        extraPanels,
        widePanels,
        panelMinWidth,
        classicPanels,
        maxRows,
        signalRows,
        producerRows,
        calendarRows,
        pumpRows,
        calTz,
        calTzLabel,
        briefTitle,
        title,
        subtitle,
        baseUrl,
        csvBase,
        csvProxy,
        csvFiles,
        debug,
        footerText,
        titleFont,
        titleColor,
        titleCase,
        titleGap,
        titleSubGap,
        headingFont,
        headingColor,
        headingCase,
        bodyFont,
        dataFont,
        labelCase,
        mutedColor,
        lineColor,
        upColor,
        downColor,
        tickerBg,
        tickerText,
        tickerLabel,
        tickerLabelBg,
        tickerLabelText,
        tickerName,
        tickerUp,
        tickerDown,
        defaultTab,
        defaultCountry,
        defaultMetric,
        showTicker,
        refreshMinutes,
        density,
        background,
        panelHeader,
        ink,
        accent,
        heat,
    } = props

    // must be set before any child calls useCSV
    CSV_BASE = (csvBase || DATA_URL).replace(/\/+$/, "")
    CSV_PROXY = (csvProxy || "").trim()
    DEBUG_RAW = !!debug
    CSV_FILES = {}
    ;(csvFiles || []).forEach((r) => {
        if (r && r.slug && r.file) CSV_FILES[r.slug] = r.file
    })
    API_BASE = (baseUrl || DATA_URL).replace(/\/+$/, "")

    // Hidden until mounted in the browser and fonts are ready (max 1.5 s).
    // Server HTML and first client render are identical (both hidden), so
    // any hydration re-render and the font swap happen out of sight.
    const [shown, setShown] = React.useState(false)
    React.useEffect(() => {
        let ok = true
        Promise.race([
            fontsReady(),
            new Promise((r) => setTimeout(r, 1500)),
        ]).then(() => ok && setShown(true))
        return () => {
            ok = false
        }
    }, [])

    const [tab, setTab] = React.useState(defaultTab)
    const [q, setQ] = React.useState("")
    React.useEffect(() => setTab(defaultTab), [defaultTab])
    const [selected, setSelected] = React.useState(
        (defaultCountry || "FRA").toUpperCase()
    )
    React.useEffect(
        () => setSelected((defaultCountry || "FRA").toUpperCase()),
        [defaultCountry]
    )

    const base = (baseUrl || DATA_URL).replace(/\/+$/, "")
    const refreshMs = Math.max(5, refreshMinutes || 5) * 60000
    const limit = density === "compact" ? 6 : 9
    const term = q.trim().toLowerCase()
    const visible = classicPanels
        ? PANELS.filter((p) =>
              term
                  ? (p.title + " " + p.code + " " + p.tags.join(" "))
                        .toLowerCase()
                        .includes(term)
                  : p.tags.includes(tab)
          )
        : []
    const showDash = !term && tab === "overview"

    const order: XId[] = Array.from(
        new Set(
            (Array.isArray(extraPanels) ? extraPanels : XIDS).filter(
                (id): id is XId => XIDS.includes(id as XId)
            )
        )
    )
    const xVisible = order.filter((id) => {
        const p = XPANELS.find((x) => x.id === id)!
        return term
            ? (p.title + " " + p.id + " " + p.tags.join(" "))
                  .toLowerCase()
                  .includes(term)
            : p.tags.includes(tab)
    })
    const wide = Array.isArray(widePanels) ? widePanels : []

    const ctx: XCtx = {
        base,
        refreshMs,
        rows: Math.max(1, maxRows || 14),
        signalRows: Math.max(1, signalRows || 8),
        producerRows: Math.max(1, producerRows || 13),
        calendarRows: Math.max(1, calendarRows || 9),
        pumpRows: Math.max(1, pumpRows || 4),
        selected,
        onSelect: setSelected,
        calTz: calTz || "Africa/Lagos",
        calTzLabel: calTzLabel ?? "",
        briefTitle: briefTitle ?? "",
    }

    // one shared layout for the new panels and the original ones
    const allItems: GridItem[] = [
        ...xVisible.map((id) => ({
            id: "x-" + id,
            wide: wide.includes(id),
            node: <XPanel id={id} ctx={ctx} />,
        })),
        ...visible.map((p) => ({
            id: "c-" + p.id,
            wide: !!p.wide || wide.includes(p.id),
            node: (
                <PanelView
                    def={p}
                    base={base}
                    refreshMs={refreshMs}
                    limit={limit}
                />
            ),
        })),
    ]
    const gridItems: GridItem[] =
        wideFirst !== false
            ? [
                  ...allItems.filter((x) => x.wide),
                  ...allItems.filter((x) => !x.wide),
              ]
            : allItems

    const vars = {
        "--bg": background,
        "--hd": panelHeader,
        "--ink": ink,
        "--acc": accent,
        "--heat": heat,
        "--cl1": countryLine1 || "#2F8F5B",
        "--cl2": countryLine2 || "#E07B39",
        "--mute": mutedColor,
        "--rule": lineColor,
        "--up": upColor,
        "--dn": downColor,
        "--link": accent,
        "--hc": headingColor || ink,
        "--hcr": headingColor || accent,
        "--tkbg": tickerBg,
        "--tktx": tickerText,
        "--tlbg": tickerLabelBg || accent,
        "--tltx": tickerLabelText,
        "--tkname": tickerName,
        "--tkup": tickerUp,
        "--tkdn": tickerDown,
        "--tktop": Math.max(0, tickerTop || 0) + "px",
        "--xmin": Math.max(240, panelMinWidth || 360) + "px",
        "--fh":
            fam(headingFont, "Georgia,serif") ||
            '"Playfair Display",Georgia,serif',
        "--fb":
            fam(bodyFont, "Helvetica,Arial,sans-serif") ||
            '"Instrument Sans",Helvetica,Arial,sans-serif',
        "--fm":
            fam(dataFont, "ui-monospace,monospace") ||
            '"JetBrains Mono",ui-monospace,monospace',
        "--tc-title": titleCase || "none",
        "--tc-head": headingCase || "none",
        "--tc-label": labelCase || "none",
        "--tc-th": !labelCase || labelCase === "none" ? "uppercase" : labelCase,
    } as React.CSSProperties

    const fade: React.CSSProperties = {
        opacity: shown ? 1 : 0,
        transition: "opacity .25s ease",
    }

    // Single panel: drop it anywhere on the Framer canvas
    if (mode && mode !== "terminal" && XIDS.includes(mode as XId))
        return (
            <div className="cet cet-solo" style={{ ...vars, ...fade }}>
                <style>{CSS}</style>
                <XPanel id={mode as XId} ctx={ctx} />
            </div>
        )

    return (
        <div className="cet" style={{ ...vars, ...fade }}>
            <style>{CSS}</style>
            {title ? (
                <h1
                    style={{
                        ...(titleFont || {}),
                        color: titleColor || undefined,
                        marginBottom: subtitle ? titleSubGap : titleGap,
                    }}
                >
                    {title}
                </h1>
            ) : null}
            {subtitle ? (
                <p className="cet-sub" style={{ marginBottom: titleGap }}>
                    {subtitle}
                </p>
            ) : null}
            {showTicker && (
                <Ticker
                    base={base}
                    refreshMs={refreshMs}
                    label={tickerLabel}
                    sticky={tickerSticky !== false}
                    autoTop={tickerAutoTop !== false}
                    manualTop={tickerTop || 0}
                />
            )}
            <div className="cet-cmd">
                <input
                    className="cet-in"
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Find a panel: brent, signals, solar, PWR"
                    aria-label="Find a panel"
                />
                <div className="cet-tabs" role="group" aria-label="Views">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            className="cet-tab"
                            aria-pressed={!term && tab === t.id}
                            onClick={() => {
                                setQ("")
                                setTab(t.id)
                            }}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>
            {showDash && (
                <Dashboard
                    base={base}
                    refreshMs={refreshMs}
                    benchSlider={benchSlider}
                    benchSpeed={benchSpeed}
                    worldRotate={worldRotate}
                    worldSpeed={worldSpeed}
                    defaultMetric={defaultMetric}
                    selected={selected}
                    setSelected={setSelected}
                />
            )}
            {gridItems.length > 0 ? (
                <XGrid
                    items={gridItems}
                    minW={Math.max(240, panelMinWidth || 360)}
                    layout={layout || "rows"}
                    cardHeight={
                        (layout || "rows") === "masonry" ? 0 : cardHeight || 0
                    }
                />
            ) : !showDash ? (
                <p className="cet-none">No panel matches “{q}”.</p>
            ) : null}
            {footerText ? <p className="cet-foot">{footerText}</p> : null}
        </div>
    )
}

EnergyTerminal.defaultProps = {
    mode: "terminal",
    tickerSticky: true,
    tickerAutoTop: true,
    tickerTop: 0,
    benchSlider: true,
    benchSpeed: 8,
    worldRotate: true,
    worldSpeed: 8,
    layout: "rows",
    wideFirst: true,
    cardHeight: 0,
    extraPanels: XIDS,
    widePanels: ["powerhours"],
    panelMinWidth: 360,
    classicPanels: true,
    maxRows: 14,
    signalRows: 8,
    producerRows: 13,
    calendarRows: 9,
    pumpRows: 4,
    calTz: "Africa/Lagos",
    calTzLabel: "Lagos time",
    briefTitle: "The Economic Bearings Energy Brief",
    title: "",
    subtitle: "",
    baseUrl: DATA_URL,
    csvBase: DATA_URL,
    csvProxy: "",
    csvFiles: [],
    debug: false,
    footerText: "Sources are credited on each panel.",
    titleCase: "none",
    titleGap: 22,
    titleSubGap: 6,
    headingCase: "none",
    labelCase: "none",
    mutedColor: "#7B6D67",
    lineColor: "#E6D8CF",
    upColor: "#1E8E45",
    downColor: "#B00F1E",
    tickerBg: "#23201D",
    tickerText: "#F3EBE3",
    tickerLabel: "Live",
    tickerLabelBg: "#9B0A14",
    tickerLabelText: "#FFFFFF",
    tickerName: "#CFC3B8",
    tickerUp: "#62D08D",
    tickerDown: "#FF8791",
    defaultTab: "overview",
    defaultCountry: "FRA",
    defaultMetric: "access",
    showTicker: false,
    refreshMinutes: 5,
    density: "comfortable",
    background: "#F8EFE9",
    panelHeader: "#FCF7F4",
    ink: "#1E1614",
    accent: "#9B0A14",
    heat: "#B3261E",
    countryLine1: "#2F8F5B",
    countryLine2: "#E07B39",
}

const PANEL_TITLES = XPANELS.map((p) => p.title)
const isTerminal = (p: any) => !p.mode || p.mode === "terminal"

const CONTROLS: Record<string, any> = {
    mode: {
        type: ControlType.Enum,
        title: "Show",
        options: ["terminal", ...XIDS],
        optionTitles: ["Full terminal", ...PANEL_TITLES],
    },
    layout: {
        type: ControlType.Enum,
        title: "Layout",
        options: ["rows", "masonry", "grid"],
        optionTitles: [
            "Rows (same size)",
            "Masonry (fill gaps)",
            "Grid (top aligned)",
        ],
        hidden: (p: any) => !isTerminal(p),
    },
    wideFirst: {
        type: ControlType.Boolean,
        title: "Wide first",
        description: "Full-width panels go to the top of each tab.",
        hidden: (p: any) => !isTerminal(p),
    },
    cardHeight: {
        type: ControlType.Number,
        title: "Card height",
        description:
            "0 = height of the tallest card in the row. A value gives every card the same fixed height (scrolls inside).",
        min: 0,
        max: 1200,
        step: 10,
        unit: "px",
        hidden: (p: any) => !isTerminal(p) || p.layout === "masonry",
    },
    benchSlider: {
        type: ControlType.Boolean,
        title: "Auto-rotate",
        description:
            "Shows the next benchmark on its own; stops while the cursor is on the panel.",
        hidden: (p: any) => !isTerminal(p),
    },
    benchSpeed: {
        type: ControlType.Number,
        title: "Seconds each",
        description: "How long each benchmark stays before the next one.",
        min: 2,
        max: 60,
        step: 1,
        unit: "s",
        hidden: (p: any) => !isTerminal(p) || p.benchSlider === false,
    },
    worldRotate: {
        type: ControlType.Boolean,
        title: "Map auto-rotate",
        description:
            "World Energy shows the next metric on its own; stops while the cursor is on the map.",
        hidden: (p: any) => !isTerminal(p),
    },
    worldSpeed: {
        type: ControlType.Number,
        title: "Map seconds",
        min: 2,
        max: 60,
        step: 1,
        unit: "s",
        hidden: (p: any) => !isTerminal(p) || p.worldRotate === false,
    },
    extraPanels: {
        type: ControlType.Array,
        title: "Panels",
        description: "Add, remove and drag to reorder the extra panels.",
        defaultValue: XIDS,
        control: {
            type: ControlType.Enum,
            options: XIDS,
            optionTitles: PANEL_TITLES,
        },
        hidden: (p: any) => !isTerminal(p),
    },
    widePanels: {
        type: ControlType.Array,
        title: "Full width",
        defaultValue: ["powerhours"],
        control: {
            type: ControlType.Enum,
            options: XIDS,
            optionTitles: PANEL_TITLES,
        },
        hidden: (p: any) => !isTerminal(p),
    },
    panelMinWidth: {
        type: ControlType.Number,
        title: "Column min",
        min: 240,
        max: 900,
        step: 10,
        unit: "px",
        hidden: (p: any) => !isTerminal(p),
    },
    classicPanels: {
        type: ControlType.Boolean,
        title: "Classic panels",
        hidden: (p: any) => !isTerminal(p),
    },
    maxRows: {
        type: ControlType.Number,
        title: "Rows (lists)",
        min: 3,
        max: 40,
        step: 1,
    },
    signalRows: {
        type: ControlType.Number,
        title: "Rows (signals)",
        min: 3,
        max: 20,
        step: 1,
    },
    producerRows: {
        type: ControlType.Number,
        title: "Rows (producers)",
        min: 5,
        max: 40,
        step: 1,
    },
    calendarRows: {
        type: ControlType.Number,
        title: "Rows (calendar)",
        min: 3,
        max: 20,
        step: 1,
    },
    pumpRows: {
        type: ControlType.Number,
        title: "Rows (pump)",
        min: 2,
        max: 10,
        step: 1,
    },
    calTz: {
        type: ControlType.String,
        title: "Calendar zone",
        description: "IANA time zone, e.g. Africa/Lagos, Europe/Paris.",
    },
    calTzLabel: { type: ControlType.String, title: "Zone label" },
    briefTitle: {
        type: ControlType.String,
        title: "Brief name",
        description: "Sun and Wed 07:00 in the calendar zone. Empty hides it.",
    },
    title: {
        type: ControlType.String,
        title: "Title",
        hidden: (p: any) => !isTerminal(p),
    },
    subtitle: {
        type: ControlType.String,
        title: "Subtitle",
        hidden: (p: any) => !isTerminal(p),
    },
    baseUrl: { type: ControlType.String, title: "API base" },
    csvBase: { type: ControlType.String, title: "CSV base" },
    csvProxy: {
        type: ControlType.String,
        title: "CSV proxy",
        description: "Only if CORS is blocked. Use {url} as placeholder.",
    },
    debug: { type: ControlType.Boolean, title: "Debug raw data" },
    footerText: {
        type: ControlType.String,
        title: "Footer text",
        hidden: (p: any) => !isTerminal(p),
    },
    titleFont: {
        type: ControlType.Font,
        title: "Title font",
        controls: "extended",
        hidden: (p: any) => !isTerminal(p),
    },
    titleColor: {
        type: ControlType.Color,
        title: "Title color",
        optional: true,
        hidden: (p: any) => !isTerminal(p),
    },
    titleCase: {
        type: ControlType.Enum,
        title: "Title case",
        options: ["none", "uppercase", "lowercase", "capitalize"],
        optionTitles: ["As typed", "UPPERCASE", "lowercase", "Capitalize"],
        hidden: (p: any) => !isTerminal(p),
    },
    titleGap: {
        type: ControlType.Number,
        title: "Title spacing",
        min: 0,
        max: 160,
        step: 2,
        unit: "px",
        hidden: (p: any) => !isTerminal(p),
    },
    titleSubGap: {
        type: ControlType.Number,
        title: "Title to subtitle",
        min: 0,
        max: 80,
        step: 2,
        unit: "px",
        hidden: (p: any) => !isTerminal(p),
    },
    headingFont: { type: ControlType.Font, title: "Heading font" },
    headingColor: {
        type: ControlType.Color,
        title: "Heading color",
        optional: true,
    },
    headingCase: {
        type: ControlType.Enum,
        title: "Heading case",
        options: ["none", "uppercase", "lowercase", "capitalize"],
        optionTitles: ["As typed", "UPPERCASE", "lowercase", "Capitalize"],
    },
    bodyFont: { type: ControlType.Font, title: "Body font" },
    dataFont: { type: ControlType.Font, title: "Numbers font" },
    labelCase: {
        type: ControlType.Enum,
        title: "Labels case",
        options: ["none", "uppercase", "lowercase", "capitalize"],
        optionTitles: ["As typed", "UPPERCASE", "lowercase", "Capitalize"],
    },
    mutedColor: { type: ControlType.Color, title: "Muted text" },
    lineColor: { type: ControlType.Color, title: "Borders" },
    upColor: { type: ControlType.Color, title: "Up color" },
    downColor: { type: ControlType.Color, title: "Down color" },
    tickerBg: {
        type: ControlType.Color,
        title: "Ticker bg",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerText: {
        type: ControlType.Color,
        title: "Ticker text",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerName: {
        type: ControlType.Color,
        title: "Ticker names",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerUp: {
        type: ControlType.Color,
        title: "Ticker up",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerDown: {
        type: ControlType.Color,
        title: "Ticker down",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerLabel: {
        type: ControlType.String,
        title: "Ticker label",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerLabelBg: {
        type: ControlType.Color,
        title: "Label bg",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerLabelText: {
        type: ControlType.Color,
        title: "Label text",
        hidden: (p: any) => !isTerminal(p),
    },
    csvFiles: {
        type: ControlType.Array,
        title: "CSV files",
        description: "Upload the CSVs here if the server blocks CORS.",
        defaultValue: CSV_SLUGS.map((slug) => ({ slug })),
        control: {
            type: ControlType.Object,
            controls: {
                slug: {
                    type: ControlType.Enum,
                    title: "Indicator",
                    options: CSV_SLUGS,
                },
                file: {
                    type: ControlType.File,
                    title: "File",
                    allowedFileTypes: ["csv"],
                },
            },
        },
    },
    defaultTab: {
        type: ControlType.Enum,
        title: "Start view",
        options: TABS.map((t) => t.id),
        optionTitles: TABS.map((t) => t.label),
        hidden: (p: any) => !isTerminal(p),
    },
    defaultCountry: { type: ControlType.String, title: "Country (ISO3)" },
    defaultMetric: {
        type: ControlType.Enum,
        title: "Map metric",
        options: METRICS.map((m) => m.id),
        optionTitles: METRICS.map((m) => m.label),
        hidden: (p: any) => !isTerminal(p),
    },
    showTicker: {
        type: ControlType.Boolean,
        title: "Ticker",
        hidden: (p: any) => !isTerminal(p),
    },
    tickerSticky: {
        type: ControlType.Boolean,
        title: "Ticker sticky",
        description:
            "The ticker stays at the top of the screen while scrolling.",
        hidden: (p: any) => !isTerminal(p) || !p.showTicker,
    },
    tickerAutoTop: {
        type: ControlType.Boolean,
        title: "Under site menu",
        description:
            "Finds your fixed menu bar and places the ticker just below it.",
        hidden: (p: any) =>
            !isTerminal(p) || !p.showTicker || p.tickerSticky === false,
    },
    tickerTop: {
        type: ControlType.Number,
        title: "Sticky offset",
        description:
            "Extra space below the menu (or distance from the top if 'Under site menu' is off).",
        min: 0,
        max: 300,
        step: 1,
        unit: "px",
        hidden: (p: any) =>
            !isTerminal(p) || !p.showTicker || p.tickerSticky === false,
    },
    refreshMinutes: {
        type: ControlType.Number,
        title: "Refresh (min)",
        min: 5,
        max: 60,
        step: 5,
    },
    density: {
        type: ControlType.Enum,
        title: "Density",
        options: ["comfortable", "compact"],
        optionTitles: ["Comfortable", "Compact"],
        displaySegmentedControl: true,
        hidden: (p: any) => !isTerminal(p),
    },
    background: { type: ControlType.Color, title: "Background" },
    panelHeader: { type: ControlType.Color, title: "Card" },
    ink: { type: ControlType.Color, title: "Text" },
    accent: { type: ControlType.Color, title: "Accent" },
    heat: { type: ControlType.Color, title: "Heat scale" },
    countryLine1: {
        type: ControlType.Color,
        title: "Country line 1",
        description: "Production, generation, clean share, electricity access.",
        hidden: (p: any) => !isTerminal(p),
    },
    countryLine2: {
        type: ControlType.Color,
        title: "Country line 2",
        description: "CO₂ per person and the currency.",
        hidden: (p: any) => !isTerminal(p),
    },
}

addPropertyControls(EnergyTerminal, CONTROLS)

/* ------------------------------------------------------------------ */
/* Single-panel components (insert each one anywhere on the canvas)    */
/* ------------------------------------------------------------------ */

const SOLO_KEYS = [
    "baseUrl",
    "csvBase",
    "csvProxy",
    "csvFiles",
    "defaultCountry",
    "maxRows",
    "signalRows",
    "producerRows",
    "calendarRows",
    "pumpRows",
    "calTz",
    "calTzLabel",
    "briefTitle",
    "refreshMinutes",
    "debug",
    "headingFont",
    "headingColor",
    "headingCase",
    "bodyFont",
    "dataFont",
    "labelCase",
    "panelHeader",
    "ink",
    "accent",
    "heat",
    "mutedColor",
    "lineColor",
    "upColor",
    "downColor",
]
const SOLO_CONTROLS: Record<string, any> = {}
SOLO_KEYS.forEach((k) => (SOLO_CONTROLS[k] = CONTROLS[k]))

/**
 * @framerIntrinsicWidth 460
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function SignalsPanel(props: any) {
    return <EnergyTerminal {...props} mode="signals" />
}
/**
 * @framerIntrinsicWidth 560
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function CommoditiesPanel(props: any) {
    return <EnergyTerminal {...props} mode="commodities" />
}
/**
 * @framerIntrinsicWidth 520
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function EquitiesPanel(props: any) {
    return <EnergyTerminal {...props} mode="equities" />
}
/**
 * @framerIntrinsicWidth 1000
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function PowerHoursPanel(props: any) {
    return <EnergyTerminal {...props} mode="powerhours" />
}
/**
 * @framerIntrinsicWidth 620
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function ProducersPanel(props: any) {
    return <EnergyTerminal {...props} mode="producers" />
}
/**
 * @framerIntrinsicWidth 520
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function UsFundamentalsPanel(props: any) {
    return <EnergyTerminal {...props} mode="usweekly" />
}
/**
 * @framerIntrinsicWidth 440
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function ReleaseCalendarPanel(props: any) {
    return <EnergyTerminal {...props} mode="calendar" />
}
/**
 * @framerIntrinsicWidth 420
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function WorldEnergyPanel(props: any) {
    return <EnergyTerminal {...props} mode="worldenergy" />
}
/**
 * @framerIntrinsicWidth 420
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function SunTodayPanel(props: any) {
    return <EnergyTerminal {...props} mode="sun" />
}
/**
 * @framerIntrinsicWidth 460
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export function PumpPricesPanel(props: any) {
    return <EnergyTerminal {...props} mode="pump" />
}

;[
    SignalsPanel,
    CommoditiesPanel,
    EquitiesPanel,
    PowerHoursPanel,
    ProducersPanel,
    UsFundamentalsPanel,
    ReleaseCalendarPanel,
    WorldEnergyPanel,
    SunTodayPanel,
    PumpPricesPanel,
].forEach((C: any) => {
    C.defaultProps = EnergyTerminal.defaultProps
    addPropertyControls(C, SOLO_CONTROLS)
})
