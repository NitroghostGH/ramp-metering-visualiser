"""Views: page shell + JSON simulation API for Queensland motorway corridors."""
from __future__ import annotations

import json

from django.http import JsonResponse, HttpResponseBadRequest
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from . import corridors
from .engine import Physics, Simulation


_LIMITS = {
    "demand_level":   (0.4, 1.4),
    "alinea_gain":    (5.0, 300.0),
    "target_occ":     (8.0, 40.0),
    "control_period": (10.0, 120.0),
    "cap_drop":       (0.0, 0.30),
    "vsl_gain":       (0.0, 60.0),
    "vsl_hold":       (30.0, 600.0),
    "vsl_zone":       (0.5, 8.0),
    "hero_master":    (0.1, 0.9),
}


def _clamp(name, value, default):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    lo, hi = _LIMITS[name]
    return min(max(value, lo), hi)


@require_GET
def index(request):
    p = Physics()
    ctx = {
        "corridors": json.dumps(corridors.list_corridors()),
        "defaults": json.dumps({
            "corridor": corridors.default_id(),
            "demand_level": 1.0,
            "alinea_gain": p.alinea_gain,
            "target_occ": round(p.target_occupancy, 1),
            "control_period": p.control_period,
            "cap_drop": p.cap_drop,
            "vsl_gain": p.vsl_gain,
            "vsl_hold": p.vsl_hold,
            "vsl_zone": p.vsl_zone_km,
            "hero_master": p.hero_master,
            "v_free": p.v_free,
            "rho_max": p.rho_max,
            "horizon": p.horizon,
            "step": p.T,
        }),
    }
    return render(request, "simulator/index.html", ctx)


@require_GET
def corridor_list(request):
    return JsonResponse({"corridors": corridors.list_corridors()})


def _parse_profile(raw, corridor, horizon):
    """Validate an uploaded demand profile. Returns (profile|None, error|None).

    Expected shape: {"time_s":[...], "mainline":[...], "ramps":[[...], ...]}
    with one ramp series per on-ramp, all the same length as time_s. Values are
    veh/h and are clamped to sane bounds. Returns (None, None) when absent."""
    if not raw:
        return None, None
    if not isinstance(raw, dict):
        return None, "must be an object"
    try:
        ts = [float(x) for x in raw.get("time_s", [])]
        main = [float(x) for x in raw.get("mainline", [])]
        ramps = [[float(x) for x in series] for series in raw.get("ramps", [])]
    except (TypeError, ValueError):
        return None, "values must be numeric"

    n = len(ts)
    if n < 2:
        return None, "need at least two time points"
    if n > 2000:
        return None, "too many rows (max 2000)"
    if any(ts[i + 1] <= ts[i] for i in range(n - 1)):
        return None, "time_s must be strictly increasing"
    if len(main) != n:
        return None, "mainline length must match time_s"

    nr = len(corridor["on_ramps"])
    # pad / truncate ramp series to the corridor's on-ramp count
    ramps = ramps[:nr] + [[0.0] * n for _ in range(max(0, nr - len(ramps)))]
    for j in range(nr):
        if len(ramps[j]) != n:
            return None, f"ramp series {j + 1} length must match time_s"

    clamp = lambda v: min(12000.0, max(0.0, v))
    return {
        "time_s": ts,
        "mainline": [clamp(v) for v in main],
        "ramps": [[clamp(v) for v in s] for s in ramps],
    }, None


# Stateless compute endpoint: no auth, no cookies, no server-side state to forge
# against, so CSRF protection is unnecessary and would block the plain fetch POST.
@csrf_exempt
@require_POST
def simulate(request):
    try:
        body = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return HttpResponseBadRequest("invalid JSON")

    corridor = corridors.build(body.get("corridor", "pacific_m3"))

    p = Physics()
    p.alinea_gain = _clamp("alinea_gain", body.get("alinea_gain"), p.alinea_gain)
    p.control_period = _clamp("control_period", body.get("control_period"), p.control_period)
    p.cap_drop = _clamp("cap_drop", body.get("cap_drop"), p.cap_drop)
    p.vsl_gain = _clamp("vsl_gain", body.get("vsl_gain"), p.vsl_gain)
    p.vsl_hold = _clamp("vsl_hold", body.get("vsl_hold"), p.vsl_hold)
    p.vsl_zone_km = _clamp("vsl_zone", body.get("vsl_zone"), p.vsl_zone_km)
    p.hero_master = _clamp("hero_master", body.get("hero_master"), p.hero_master)
    if body.get("target_occ") is not None:
        p.target_occ = _clamp("target_occ", body.get("target_occ"), p.target_occupancy)
    level = _clamp("demand_level", body.get("demand_level"), 1.0)

    profile, profile_err = _parse_profile(body.get("demand_profile"), corridor, p.horizon)
    if profile_err:
        return HttpResponseBadRequest("demand profile: " + profile_err)

    combos = {
        "none":       ("none", False),
        "alinea":     ("alinea", False),
        "hero":       ("hero", False),
        "none_vsl":   ("none", True),
        "alinea_vsl": ("alinea", True),
        "hero_vsl":   ("hero", True),
    }
    results = {}
    for key, (control, vsl) in combos.items():
        results[key] = Simulation(corridor, p, level, control, vsl,
                                  demand_profile=profile).run()

    meta = {
        "id": corridor["id"], "name": corridor["name"], "route": corridor["route"],
        "direction": corridor["direction"], "note": corridor["note"],
        "seg_length": corridor["seg_length"], "n_segments": corridor["n_segments"],
        "length_km": corridor["length_km"], "lanes": corridor["lanes"],
        "vlimit": corridor["vlimit"], "split": corridor["split"],
        "bottleneck_seg": corridor["bottleneck_seg"],
        "demand_scale": corridor["demand_scale"],
        "mainline_demand": corridor["mainline_demand"],
        "ramps": [{"seg": r["seg"], "km": r["km"], "name": r["name"],
                   "kind": r["kind"], "demand": r["demand"], "geo": r["geo"],
                   "split": r["split"]} for r in corridor["ramps"]],
        "on_ramps": [{"seg": r["seg"], "name": r["name"], "geo": r["geo"],
                      "km": r["km"], "storage": r["storage"]}
                     for r in corridor["on_ramps"]],
        "ramp_capacity": p.ramp_capacity,
        "vsl_step": p.vsl_step, "vsl_hold": p.vsl_hold, "vsl_zone_km": p.vsl_zone_km,
        "geo": corridor["geo"],
        "target_occupancy": round(p.target_occupancy, 2),
        "rho_crit": p.rho_crit, "rho_max": p.rho_max, "v_free": p.v_free, "a_fd": p.a_fd,
        "step": p.T, "horizon": p.horizon, "demand_level": level,
        "demand_source": "uploaded" if profile else "synthetic",
    }
    return JsonResponse({"meta": meta, "results": results})
