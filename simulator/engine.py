"""
Multi-ramp METANET freeway model with local ALINEA metering, HERO-style
coordinated metering, and feedback variable speed limits (VSL).

A corridor (see ``corridors.py``) is a chain of ``N`` segments, each with its
own lane count ``lanes[i]`` and posted speed limit ``vlimit[i]``. On-ramps merge
at given segments; each carries an origin queue and a metering rate. Off-ramps
drain a fixed proportion of the passing flow.

Control modes
-------------
* ``none``    - ramps run free.
* ``alinea``  - each on-ramp is metered locally by ALINEA:
                r_j(k) = r_j(k-1) + K_R ( o_hat - o_j(k) ).
* ``hero``    - local ALINEA plus HERO-style coordination: when an active
                bottleneck ramp starts to fill its limited storage, upstream
                ramps are recruited to store vehicles too, balancing queue
                fill-ratios so no single ramp overflows onto the arterial.

References: Papageorgiou et al. (1991) ALINEA; Papamichail & Papageorgiou (2010)
HERO at the Monash Freeway; Faulkner et al. (2014) HERO on the QLD M1/M3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class Physics:
    v_free: float = 110.0         # FD free-flow speed (km/h); posted limits cap it
    rho_crit: float = 33.5        # critical density (veh/km/lane)
    rho_max: float = 180.0        # jam density (veh/km/lane)
    a_fd: float = 1.867           # FD exponent
    tau: float = 0.005            # relaxation time (h)
    nu: float = 35.0              # anticipation (km^2/h)
    kappa: float = 13.0           # anticipation smoothing (veh/km/lane)
    delta: float = 0.0122         # merge term
    phi: float = 1.4              # lane-drop term
    cap_drop: float = 0.13        # capacity drop at active bottlenecks

    # controllers
    alinea_gain: float = 70.0     # K_R (veh/h)
    control_period: float = 60.0  # s
    r_min: float = 240.0          # veh/h
    ramp_capacity: float = 1600.0 # veh/h (metered max per ramp)
    target_occ: float | None = None

    # HERO coordination
    hero_master: float = 0.4      # fill ratio that triggers upstream recruitment

    # VSL
    vsl_gain: float = 18.0
    vsl_min: float = 40.0
    vsl_compliance: float = 1.0

    # clock
    T: float = 10.0               # s
    horizon: float = 3600.0       # s

    def occ_of(self, rho):
        return 100.0 * rho / self.rho_max

    @property
    def target_occupancy(self):
        if self.target_occ is not None:
            return self.target_occ
        return self.occ_of(self.rho_crit)


def _trapezoid(t, base, peak, t0, t1, t2, t3):
    if t < t0: return base
    if t < t1: return base + (peak - base) * (t - t0) / (t1 - t0)
    if t < t2: return peak
    if t < t3: return peak + (base - peak) * (t - t2) / (t3 - t2)
    return base


def demand_scale(t, horizon):
    """Shared AM-peak temporal shape in [base..1] used for all demands."""
    return _trapezoid(t, 0.55, 1.0, 0.10 * horizon, 0.30 * horizon,
                      0.62 * horizon, 0.85 * horizon)


class Simulation:
    def __init__(self, corridor, phys: Physics, demand_level=1.0,
                 control="alinea", vsl=False, demand_profile=None):
        self.c = corridor
        self.p = phys
        self.level = demand_level
        self.control = control
        self.vsl = vsl
        # optional uploaded demand profile: {"time_s":[...], "mainline":[...],
        # "ramps":[[per-on-ramp veh/h series]...]}. Overrides synthetic demand.
        self.profile = demand_profile

        N = corridor["n_segments"]
        self.N = N
        self.lanes = corridor["lanes"]
        self.vlimit = corridor["vlimit"]
        self.split = corridor["split"]

        self.rho = [6.0] * N
        self.v = [min(self.p.v_free, self.vlimit[i]) for i in range(N)]
        self.w_main = 0.0

        # on-ramps
        self.on = corridor["on_ramps"]
        self.nr = len(self.on)
        self.w = [0.0] * self.nr                       # queues
        self.r = [self.p.ramp_capacity] * self.nr      # metering rates
        self.storage = [max(40.0, o["storage"]) for o in self.on]

        # bottleneck segments = on-ramp merges + lane drops
        self.bottlenecks = set(o["seg"] for o in self.on)
        for i in range(N - 1):
            if self.lanes[i + 1] < self.lanes[i]:
                self.bottlenecks.add(i + 1)

        self.vsl_limit = self.p.v_free

    # -- demand ---------------------------------------------------------------
    @staticmethod
    def _interp(ts, ys, t):
        """Linear interpolation of ys(ts) at t (ts sorted, seconds)."""
        if t <= ts[0]:
            return ys[0]
        if t >= ts[-1]:
            return ys[-1]
        lo, hi = 0, len(ts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if ts[mid] <= t:
                lo = mid
            else:
                hi = mid
        span = ts[hi] - ts[lo]
        f = (t - ts[lo]) / span if span else 0.0
        return ys[lo] + (ys[hi] - ys[lo]) * f

    def demand_at(self, t):
        """Return (mainline, [per-on-ramp]) demand in veh/h at time t seconds.
        Uses an uploaded profile if present, else the synthetic AM-peak shape.
        The demand-level slider scales either one."""
        if self.profile:
            ts = self.profile["time_s"]
            main = self._interp(ts, self.profile["mainline"], t) * self.level
            ramps = [self._interp(ts, self.profile["ramps"][j], t) * self.level
                     for j in range(self.nr)]
            return main, ramps
        ds = self.level * demand_scale(t, self.p.horizon)
        main = self.c["mainline_demand"] * ds
        ramps = [o["demand"] * ds for o in self.on]
        return main, ramps

    # -- fundamental diagram --------------------------------------------------
    def V_eq(self, rho, limit):
        p = self.p
        v = p.v_free * math.exp(-(1.0 / p.a_fd) * (rho / p.rho_crit) ** p.a_fd)
        return min(v, p.vsl_compliance * limit)

    # -- one METANET step -----------------------------------------------------
    def step(self, t, seg_limits):
        p, N = self.p, self.N
        T = p.T / 3600.0
        L = self.c["seg_length"]
        rho, v = self.rho, self.v
        lanes = self.lanes
        d_main, d_ramps = self.demand_at(t)

        # mainline origin
        cap0 = p.rho_crit * self.V_eq(p.rho_crit, seg_limits[0]) * lanes[0]
        recv_main = cap0
        if rho[0] > p.rho_crit:
            recv_main = cap0 * (p.rho_max - rho[0]) / (p.rho_max - p.rho_crit)
        q_main_in = min(d_main + self.w_main / T, max(0.0, recv_main))
        self.w_main = max(0.0, self.w_main + T * (d_main - q_main_in))

        # ramp origins
        ramp_in = [0.0] * self.nr
        for j, o in enumerate(self.on):
            m = o["seg"]
            d_r = d_ramps[j]
            capr = p.ramp_capacity
            recv_r = capr
            if rho[m] > p.rho_crit:
                recv_r = capr * (p.rho_max - rho[m]) / (p.rho_max - p.rho_crit)
            meter = self.r[j] if self.control != "none" else capr
            qin = min(d_r + self.w[j] / T, meter, capr, max(0.0, recv_r))
            ramp_in[j] = qin
            self.w[j] = max(0.0, self.w[j] + T * (d_r - qin))

        # segment flows and off-ramp splits
        q = [rho[i] * v[i] * lanes[i] for i in range(N)]
        cap_lane = [p.rho_crit * self.V_eq(p.rho_crit, seg_limits[i]) for i in range(N)]
        for i in self.bottlenecks:
            if rho[i] > p.rho_crit:
                q[i] = min(q[i], (1.0 - p.cap_drop) * cap_lane[i] * lanes[i])
        # flow continuing downstream after off-ramp drain
        q_next = [q[i] * (1.0 - self.split[i]) for i in range(N)]

        ramp_at = {o["seg"]: j for j, o in enumerate(self.on)}

        # density update
        new_rho = [0.0] * N
        for i in range(N):
            inflow = q_main_in if i == 0 else q_next[i - 1]
            add = ramp_in[ramp_at[i]] if i in ramp_at else 0.0
            new_rho[i] = rho[i] + (T / (L * lanes[i])) * (inflow - q[i] + add)
            new_rho[i] = min(max(new_rho[i], 0.0), p.rho_max)

        # speed update
        new_v = [0.0] * N
        for i in range(N):
            v_up = v[i - 1] if i > 0 else v[0]
            rho_dn = rho[i + 1] if i < N - 1 else rho[i]
            veq = self.V_eq(rho[i], seg_limits[i])
            relax = (T / p.tau) * (veq - v[i])
            conv = (T / L) * v[i] * (v_up - v[i])
            antic = (p.nu * T / (p.tau * L)) * (rho_dn - rho[i]) / (rho[i] + p.kappa)
            nv = v[i] + relax + conv - antic
            # merge term
            if i in ramp_at and ramp_in[ramp_at[i]] > 0:
                nv -= (p.delta * T * ramp_in[ramp_at[i]] * v[i]) / (L * lanes[i] * (rho[i] + p.kappa))
            # lane-drop term
            if i < N - 1 and lanes[i + 1] < lanes[i]:
                dl = lanes[i] - lanes[i + 1]
                nv -= (p.phi * T * dl * rho[i] * v[i] * v[i]) / (L * lanes[i] * p.rho_crit)
            new_v[i] = max(nv, 1.0)

        self.rho, self.v = new_rho, new_v
        return q_main_in, ramp_in, q_next[N - 1]

    # -- controllers ----------------------------------------------------------
    def alinea_update(self):
        p = self.p
        for j, o in enumerate(self.on):
            m = o["seg"]
            o_out = p.occ_of(self.rho[m])
            self.r[j] = self.r[j] + p.alinea_gain * (p.target_occupancy - o_out)
            self.r[j] = min(max(self.r[j], p.r_min), p.ramp_capacity)
            # local queue override: don't overflow the ramp storage
            if self.w[j] > 0.9 * self.storage[j]:
                self.r[j] = p.ramp_capacity

    def hero_update(self):
        """Local ALINEA + coordination. Downstream (highest index) first; an
        active, filling bottleneck recruits the nearest upstream ramp to store,
        equalising queue fill-ratios so storage is shared, not overflowed."""
        p = self.p
        # 1) local ALINEA rates (without the panic override - HERO manages queues)
        for j, o in enumerate(self.on):
            m = o["seg"]
            o_out = p.occ_of(self.rho[m])
            self.r[j] = self.r[j] + p.alinea_gain * (p.target_occupancy - o_out)
            self.r[j] = min(max(self.r[j], p.r_min), p.ramp_capacity)

        fill = [self.w[j] / self.storage[j] for j in range(self.nr)]
        occ = [p.occ_of(self.rho[self.on[j]["seg"]]) for j in range(self.nr)]

        # 2) coordination pass, downstream -> upstream
        for j in range(self.nr - 1, 0, -1):
            active = occ[j] > 0.98 * p.target_occupancy
            if active and fill[j] > p.hero_master:
                u = j - 1  # nearest upstream ramp
                # recruit upstream ramp to raise its fill toward the master's
                deficit = max(0.0, fill[j] - fill[u])
                if deficit > 0.05:
                    factor = max(0.35, 1.0 - deficit)
                    self.r[u] = max(p.r_min, min(self.r[u], self.r[u] * factor))

        # 3) safety: any ramp truly at storage limit is released
        for j in range(self.nr):
            if self.w[j] > 0.97 * self.storage[j]:
                self.r[j] = p.ramp_capacity

    def vsl_update(self):
        """Lower the speed limit upstream of the worst active bottleneck."""
        p = self.p
        occ = [p.occ_of(r) for r in self.rho]
        worst = max(range(self.N), key=lambda i: occ[i])
        err = occ[worst] - p.target_occupancy
        self.vsl_limit = self.vsl_limit - p.vsl_gain * (err / 10.0)
        self.vsl_limit = min(max(self.vsl_limit, p.vsl_min), p.v_free)
        return worst

    # -- run ------------------------------------------------------------------
    def run(self):
        p, N = self.p, self.N
        steps = int(round(p.horizon / p.T))
        ctrl_every = max(1, int(round(p.control_period / p.T)))
        worst = self.N - 1

        rec = {k: [] for k in ("t", "flow_out", "flow_in", "mean_speed_t", "veh_total")}
        rec["seg_rho"] = []   # per-segment density heat map
        rec["seg_v"] = []
        rec["ramp_queue"] = [[] for _ in range(self.nr)]  # per ramp
        rec["ramp_meter"] = [[] for _ in range(self.nr)]
        rec["ramp_occ"] = [[] for _ in range(self.nr)]
        rec["vsl"] = []
        rec["main_queue"] = []
        total_tt = 0.0

        for k in range(steps):
            t = k * p.T
            if k % ctrl_every == 0:
                if self.control == "alinea":
                    self.alinea_update()
                elif self.control == "hero":
                    self.hero_update()
                if self.vsl:
                    worst = self.vsl_update()

            if self.vsl:
                seg_limits = [min(self.vlimit[i],
                                  self.vsl_limit if i < worst else self.vlimit[i])
                              for i in range(N)]
            else:
                seg_limits = list(self.vlimit)

            q_main_in, ramp_in, q_out = self.step(t, seg_limits)

            veh = sum(self.rho[i] * self.c["seg_length"] * self.lanes[i] for i in range(N))
            veh += self.w_main + sum(self.w)
            total_tt += veh * (p.T / 3600.0)

            mean_v = sum(self.v[i] * self.rho[i] for i in range(N))
            dens = sum(self.rho) or 1.0
            rec["t"].append(round(t, 1))
            rec["flow_out"].append(round(q_out, 1))
            rec["flow_in"].append(round(q_main_in, 1))
            rec["mean_speed_t"].append(round(mean_v / dens, 2))
            rec["veh_total"].append(round(veh, 1))
            rec["vsl"].append(round(self.vsl_limit, 1))
            rec["main_queue"].append(round(self.w_main, 1))
            rec["seg_rho"].append([round(x, 1) for x in self.rho])
            rec["seg_v"].append([round(x, 1) for x in self.v])
            for j in range(self.nr):
                rec["ramp_queue"][j].append(round(self.w[j], 1))
                rec["ramp_meter"][j].append(round(self.r[j] if self.control != "none"
                                                  else p.ramp_capacity, 0))
                rec["ramp_occ"][j].append(round(p.occ_of(self.rho[self.on[j]["seg"]]), 1))

        # summary
        spd = rec["mean_speed_t"]
        rec["total_travel_time"] = round(total_tt, 1)
        rec["mean_speed"] = round(sum(spd) / len(spd), 1)
        rec["throughput"] = round(sum(rec["flow_out"]) / len(rec["flow_out"]), 1)
        allq = [max(rec["ramp_queue"][j]) for j in range(self.nr)] or [0]
        rec["max_ramp_queue"] = round(max(allq), 1)
        rec["total_ramp_veh"] = round(sum(self.w), 1)
        # fraction of the corridor-hour spent congested (mean speed < 60)
        cong = sum(1 for s in spd if s < 60) / len(spd)
        rec["congested_frac"] = round(cong, 3)
        return rec


def run_corridor(corridor, phys, demand_level, control, vsl):
    return Simulation(corridor, phys, demand_level, control, vsl).run()
