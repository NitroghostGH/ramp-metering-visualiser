# Integration Guide

How to make the Ramp Metering Visualiser work with **your** network and **your**
data, plus the JSON API, model tuning and production deployment.

- [1. Add a corridor](#1-add-a-corridor)
- [2. The corridor schema](#2-the-corridor-schema)
- [3. Getting real geometry (OpenStreetMap)](#3-getting-real-geometry-openstreetmap)
- [4. Real vs. calibrated demand](#4-real-vs-calibrated-demand)
- [5. The demand CSV](#5-the-demand-csv)
- [6. JSON API reference](#6-json-api-reference)
- [7. Tuning the model](#7-tuning-the-model)
- [8. Deployment](#8-deployment)
- [9. Data & privacy checklist](#9-data--privacy-checklist)

---

## 1. Add a corridor

Corridors are JSON files loaded at start-up from the first directory that exists:

1. `$RMV_CORRIDOR_DIR` (an environment variable you set), or
2. `simulator/data/corridors/` (bundled examples).

Keeping your corridors in an external `RMV_CORRIDOR_DIR` means your network
definitions live with your data, not inside the code checkout.

```bash
cp simulator/data/corridors/_TEMPLATE.json  /etc/rampviz/corridors/a99_east.json
export RMV_CORRIDOR_DIR=/etc/rampviz/corridors
# edit the file, then restart the server
```

Files whose name starts with `_` are ignored. A malformed file is skipped with a
message on stderr rather than crashing the app, so one bad corridor never takes
the site down.

## 2. The corridor schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | — | Stable identifier. Defaults to the filename. |
| `name` | string | ✓ | Display name, e.g. `"My Freeway (A99)"`. |
| `route` | string | ✓ | Short badge, e.g. `"A99"`. |
| `direction` | string | | Sub-label, e.g. `"Eastbound · AM peak"`. |
| `note` | string | | One-line description under the picker. |
| `representative` | bool | | `true` shows a **sample** badge. Set `false` for real data. |
| `calibrate` | bool | | `true` auto-scales demand into breakdown (default). `false` = use demand verbatim. |
| `seg_length` | number | ✓ | Segment length in **km** (0.4–1.0 recommended). |
| `sections` | array | ✓ | Consecutive stretches of constant geometry (below). |
| `mainline_demand` | number | ✓ | Upstream entry demand, veh/h. |
| `ramps` | array | ✓ | On- and off-ramps (below). |
| `geo` | array | ✓ | `[lat, lng]` polyline, ≥ 2 points, upstream → downstream. |

**Section** — one per change of lanes or speed limit, in order along the corridor:

```json
{"len_km": 4.0, "lanes": 3, "vlimit": 100}
```

A drop in `lanes` between consecutive sections is modelled as a lane-drop
bottleneck. `vlimit` is the posted limit in km/h (it caps the free-flow speed).

**Ramp** — placed by chainage `km` from the corridor start:

```json
{"km": 1.4, "name": "Klumpp Rd", "demand": 900, "kind": "on"}
{"km": 5.2, "name": "Exit: Mall", "demand": 0, "kind": "off", "split": 0.10}
```

| Ramp field | Meaning |
|---|---|
| `km` | Distance from the corridor start (km). |
| `name` | Interchange name. **This is how demand-CSV columns are matched.** |
| `kind` | `"on"` (metered on-ramp) or `"off"` (off-ramp). |
| `demand` | On-ramp demand, veh/h (ignored for off-ramps). |
| `split` | Off-ramp only: fraction of passing flow that exits (0–1). |
| `storage` | On-ramp only, optional: queue storage in vehicles before spill-back (default 90). |

> **Sanity check:** segment count is `round(total_length / seg_length)`. Keep
> segments a few hundred metres long so each ramp lands on its own segment and
> the model stays numerically stable at the 10 s time step.

## 3. Getting real geometry (OpenStreetMap)

To replace approximated geometry with real data, OpenStreetMap has motorway
alignments, ramp locations, `lanes` and `maxspeed` tags. A practical workflow:

1. Find the motorway way(s) in OSM and query them via the **Overpass API**
   (`https://overpass-api.de/`). Export the alignment nodes → your `geo`
   polyline; read `lanes`/`maxspeed` tags → your `sections`.
2. Ramp `km` values: measure each on-ramp merge's distance along the alignment.
3. Respect the **ODbL** licence (attribute OpenStreetMap contributors).

This app does not fetch OSM for you (to stay dependency-free and offline-capable);
prepare the JSON with your own script or GIS tool. Volumes come from your counts,
not OSM.

## 4. Real vs. calibrated demand

- `"calibrate": true` (default for the examples) scales all demands so the
  tightest section sits ~22 % over capacity at demand level 100 % — useful when
  you only have rough numbers and want a guaranteed breakdown to study.
- `"calibrate": false` uses `mainline_demand` and each ramp `demand` **exactly**
  as given. Use this with real survey/count data. The demand-level slider then
  scales your real profile (50 %–130 %) for sensitivity analysis.

For time-varying real data, upload a **demand CSV** (next section), which always
overrides the static per-corridor numbers.

## 5. The demand CSV

Upload from the **Demand data** panel. Format:

```
time_min, mainline, Klumpp Rd, Marshall Rd, Kessels Rd
0,   2600,  600,  700,  750
5,   2900,  700,  820,  880
10,  3200,  820,  950, 1010
```

- **`time_min`** — minutes from the start of the run (strictly increasing).
- **`mainline`** — upstream mainline demand, veh/h.
- **Remaining columns** — one per on-ramp, header **matched to the ramp name**
  (case- and punctuation-insensitive). Unmatched ramps default to zero; missing
  cells default to zero.
- Values are linearly interpolated between rows and clamped to `[0, 12000]` veh/h.
- The **Template** button downloads a correctly-headed CSV pre-filled for the
  selected corridor as a starting point.

> Demand is the traffic *wanting* to enter — not measured throughput (which is
> capped by the bottleneck). If you only have detector flow/occupancy, note that
> observed downstream flow understates demand during congestion; upstream counts
> ahead of the queue are a better proxy.

## 6. JSON API reference

### `GET /api/corridors`
```json
{ "corridors": [ { "id": "pacific_m3", "name": "...", "route": "M3",
                   "length_km": 12.6, "on_ramps": 6, "lanes_max": 4,
                   "representative": true }, ... ] }
```

### `POST /api/simulate`
Request body (all optional except nothing — sensible defaults throughout):
```json
{
  "corridor": "pacific_m3",
  "demand_level": 1.0,          // 0.4–1.4 multiplier
  "alinea_gain": 70,            // K_R
  "target_occ": 18.5,           // % (critical occupancy)
  "control_period": 60,         // s
  "hero_master": 0.4,           // HERO recruit threshold
  "vsl_gain": 18,
  "demand_profile": {           // optional; overrides synthetic demand
    "time_s":  [0, 1800, 3600],
    "mainline":[2600, 3400, 2600],
    "ramps":   [[600, 900, 600], ...]   // one array per on-ramp, in corridor order
  }
}
```
Response: `{ "meta": {...}, "results": { "none": {...}, "alinea": {...},
"hero": {...}, "none_vsl": {...}, "alinea_vsl": {...}, "hero_vsl": {...} } }`.
Each result holds per-frame time series (`t`, `mean_speed_t`, `flow_out`,
`seg_v`, `seg_rho`, per-ramp `ramp_queue`/`ramp_meter`/`ramp_occ`, `vsl`) plus
summary scalars (`mean_speed`, `throughput`, `total_travel_time`,
`congested_frac`, `max_ramp_queue`). Invalid demand profiles return **400** with
a message. There is no authentication — put it behind your own gateway if needed.

## 7. Tuning the model

All physics and controller parameters live in the `Physics` dataclass in
`simulator/engine.py` (free-flow speed, critical/jam density, relaxation time,
capacity drop, ALINEA gain, ramp min/max rate, HERO threshold, VSL gains, the
10 s time step and 1 h horizon). See [MODEL.md](MODEL.md) for what each does and
safe ranges. The UI exposes the most useful ones as sliders.

To add a **new controller**, implement an `xxx_update()` method on `Simulation`,
call it from `run()` on the control clock, and add the scenario key in
`views.simulate()`.

## 8. Deployment

Development needs nothing. For a public deployment:

```bash
pip install -r requirements.txt          # includes whitenoise
export DJANGO_DEBUG=0
export DJANGO_SECRET_KEY="$(python -c 'import secrets;print(secrets.token_urlsafe(50))')"
export DJANGO_ALLOWED_HOSTS="rampviz.example.gov"
export DJANGO_CSRF_TRUSTED_ORIGINS="https://rampviz.example.gov"
python manage.py collectstatic --noinput
gunicorn alineavis.wsgi           # or any WSGI/ASGI server
```

Serve behind a TLS-terminating reverse proxy (nginx/Caddy). WhiteNoise serves
the hashed static assets; no database or media storage is needed. `manage.py
check --deploy` will flag anything else for your environment.

## 9. Data & privacy checklist

- The app stores **nothing** server-side — every simulation is computed per
  request and discarded. Uploaded CSVs are parsed in the browser and sent as
  JSON to `/api/simulate`; they are not written to disk.
- No analytics, cookies, or third-party calls **except** optional map tiles
  (CartoDB/OpenStreetMap) loaded only when you open the Map tab. Disable the Map
  tab if your policy forbids external requests — the Schematic view is fully
  offline.
- Keep corridor files free of anything sensitive; they are served to the client
  as part of the corridor list.
