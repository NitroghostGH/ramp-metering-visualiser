"""
Corridor library.

Corridors are defined as JSON files in a data directory (one file per corridor)
so any agency can add their own network without touching Python. Each file is a
compact spec - ``sections`` (stretches of constant lanes / speed limit) and
``ramps`` placed by chainage - which :func:`build` expands into the per-segment
arrays the engine consumes.

Data directory (first that exists):
  1. ``$RMV_CORRIDOR_DIR`` (environment variable), if set
  2. ``simulator/data/corridors`` (bundled examples)

Files whose name begins with ``_`` (e.g. ``_TEMPLATE.json``) are ignored.

The bundled examples are *representative* models of South-East Queensland
motorways: real route / interchange / lane / speed-limit data with approximated
chainages, demands and geography. Set ``"representative": false`` and
``"calibrate": false`` for a corridor built from real survey and count data.

See ``docs/INTEGRATION.md`` for the full schema and a step-by-step guide.
"""

from __future__ import annotations

import glob
import json
import math
import os
import sys

# ~ rho_crit * v_free * exp(-1/a_fd): representative capacity per lane (veh/h).
CAP_LANE = 2157.0
# When calibrating, load the tightest section this far over capacity at 100%.
TARGET_LOAD = 1.22

_BUNDLED_DIR = os.path.join(os.path.dirname(__file__), "data", "corridors")


def _data_dir():
    return os.environ.get("RMV_CORRIDOR_DIR") or _BUNDLED_DIR


# ---------------------------------------------------------------- loading

_REQUIRED = ("name", "route", "seg_length", "sections", "mainline_demand", "ramps", "geo")


def _validate(c):
    for key in _REQUIRED:
        if key not in c:
            raise ValueError(f"missing required key '{key}'")
    if not isinstance(c["sections"], list) or not c["sections"]:
        raise ValueError("'sections' must be a non-empty list")
    for s in c["sections"]:
        for k in ("len_km", "lanes", "vlimit"):
            if k not in s:
                raise ValueError(f"section missing '{k}'")
    if not isinstance(c["geo"], list) or len(c["geo"]) < 2:
        raise ValueError("'geo' must have at least two [lat, lng] points")
    for r in c["ramps"]:
        if "km" not in r or "name" not in r or "kind" not in r:
            raise ValueError("each ramp needs 'km', 'name' and 'kind'")
        if r["kind"] not in ("on", "off"):
            raise ValueError(f"ramp kind must be 'on' or 'off', got {r['kind']!r}")


def _load_all():
    corridors = {}
    for path in sorted(glob.glob(os.path.join(_data_dir(), "*.json"))):
        base = os.path.basename(path)
        if base.startswith("_"):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                c = json.load(f)
            c["id"] = c.get("id") or os.path.splitext(base)[0]
            _validate(c)
            corridors[c["id"]] = c
        except Exception as exc:  # never let one bad file break the app
            print(f"[corridors] skipping {base}: {exc}", file=sys.stderr)
    return corridors


# loaded once at import; call reload() after adding/editing files in dev.
_CORRIDORS = _load_all()


def reload():
    global _CORRIDORS
    _CORRIDORS = _load_all()
    return _CORRIDORS


def default_id():
    if "pacific_m3" in _CORRIDORS:
        return "pacific_m3"
    return next(iter(sorted(_CORRIDORS)), None)


# ---------------------------------------------------------------- metadata

def list_corridors():
    """Lightweight metadata for the corridor picker."""
    out = []
    for cid in sorted(_CORRIDORS):
        c = _CORRIDORS[cid]
        length = sum(s["len_km"] for s in c["sections"])
        on = sum(1 for r in c["ramps"] if r["kind"] == "on")
        out.append({
            "id": cid,
            "name": c["name"],
            "route": c["route"],
            "direction": c.get("direction", ""),
            "note": c.get("note", ""),
            "length_km": round(length, 1),
            "on_ramps": on,
            "lanes_max": max(s["lanes"] for s in c["sections"]),
            "representative": bool(c.get("representative", False)),
        })
    return out


# ---------------------------------------------------------------- geometry

def _interp_geo(waypoints, frac):
    """Point at fractional chord-distance ``frac`` (0..1) along a polyline."""
    if frac <= 0:
        return waypoints[0]
    if frac >= 1:
        return waypoints[-1]
    segd = [math.hypot(waypoints[i + 1][0] - waypoints[i][0],
                       waypoints[i + 1][1] - waypoints[i][1])
            for i in range(len(waypoints) - 1)]
    total = sum(segd) or 1.0
    target = frac * total
    acc = 0.0
    for i, d in enumerate(segd):
        if acc + d >= target:
            t = (target - acc) / d if d else 0
            a, b = waypoints[i], waypoints[i + 1]
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        acc += d
    return waypoints[-1]


# ---------------------------------------------------------------- build

def build(cid):
    """Expand a corridor spec into per-segment arrays + normalised ramp list."""
    if cid not in _CORRIDORS:
        cid = default_id()
    c = _CORRIDORS[cid]
    L = c["seg_length"]
    length_km = sum(s["len_km"] for s in c["sections"])
    n = max(4, int(round(length_km / L)))

    # expand sections into per-segment lane / speed-limit arrays
    marks, cum = [], 0.0
    for s in c["sections"]:
        marks.append((cum, cum + s["len_km"], s))
        cum += s["len_km"]
    lanes, vlimit = [], []
    for i in range(n):
        mid = (i + 0.5) * L
        sec = c["sections"][-1]
        for lo, hi, s in marks:
            if lo <= mid < hi:
                sec = s
                break
        lanes.append(int(sec["lanes"]))
        vlimit.append(float(sec["vlimit"]))

    def km_to_seg(km):
        return min(n - 1, max(0, int(round(km / L))))

    ramps = []
    for r in c["ramps"]:
        ramps.append({
            "seg": km_to_seg(r["km"]),
            "km": r["km"],
            "name": r["name"],
            "demand": r.get("demand", 0),
            "kind": r["kind"],
            "split": r.get("split", 0.0),
            "geo": _interp_geo(c["geo"], min(1.0, max(0.0, r["km"] / length_km))),
            "storage": r.get("storage", 90) if r["kind"] == "on" else 0,
        })
    ramps.sort(key=lambda r: r["seg"])

    split = [0.0] * n
    for r in ramps:
        if r["kind"] == "off":
            split[r["seg"]] = max(split[r["seg"]], r["split"])

    # locate the primary bottleneck: the segment whose cumulative demand /
    # capacity ratio is highest (on-ramps add, off-ramps drain).
    on_at = {r["seg"]: r["demand"] for r in ramps if r["kind"] == "on"}
    flow, loads = c["mainline_demand"], []
    for i in range(n):
        if i in on_at:
            flow += on_at[i]
        loads.append(flow / (lanes[i] * CAP_LANE))
        if split[i] > 0:
            flow *= (1.0 - split[i])
    bneck_seg = max(range(n), key=lambda i: loads[i])

    # optionally scale synthetic demand into the breakdown regime; corridors
    # built from real counts set "calibrate": false and are used verbatim.
    if c.get("calibrate", True):
        peak_load = loads[bneck_seg] or 1.0
        scale = min(2.0, max(0.3, TARGET_LOAD / peak_load))
    else:
        scale = 1.0

    mainline_demand = c["mainline_demand"] * scale
    for r in ramps:
        r["demand"] = round(r["demand"] * scale)

    return {
        "id": cid,
        "name": c["name"],
        "route": c["route"],
        "direction": c.get("direction", ""),
        "note": c.get("note", ""),
        "representative": bool(c.get("representative", False)),
        "seg_length": L,
        "n_segments": n,
        "length_km": round(length_km, 2),
        "lanes": lanes,
        "vlimit": vlimit,
        "split": split,
        "ramps": ramps,
        "on_ramps": [r for r in ramps if r["kind"] == "on"],
        "off_ramps": [r for r in ramps if r["kind"] == "off"],
        "mainline_demand": round(mainline_demand),
        "demand_scale": round(scale, 3),
        "bottleneck_seg": bneck_seg,
        "geo": c["geo"],
    }
