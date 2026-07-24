# Model & Algorithms

The visualiser runs a macroscopic **METANET** freeway model with three
ramp-metering controllers. This document states the equations, the assumptions,
and the known limitations so results can be interpreted honestly.

## 1. Fundamental diagram

Each segment `i` has a density `ρ` (veh/km/lane) and mean speed `v` (km/h). The
equilibrium speed follows the standard METANET relation, capped by the posted (or
VSL-reduced) speed limit `V_lim`:

```
V(ρ) = min( v_free · exp[ −(1/a) · (ρ / ρ_crit)^a ] ,  V_lim )
```

Flow is `q = ρ · v · λ` (λ = lanes). Flow peaks at the **critical density**
`ρ_crit`; beyond it the road is congested and flow falls. Loop-detector
**occupancy** is proportional to density (`occ = 100 · ρ / ρ_jam`), so "target
occupancy" and "critical density" are the same idea in different units. This is a
first-order approximation: it assumes occupancy is linear in density and reaches
100% at jam density (i.e. constant effective vehicle length and negligible
detector length). It is standard for teaching; a site model would calibrate the
exact `occ = ρ · (L_veh + L_det)` relation. With the defaults, target occupancy
is `100 · 33.5 / 180 ≈ 18.6%`.

Defaults: `v_free = 110 km/h`, `ρ_crit = 33.5`, `ρ_jam = 180 veh/km/lane`,
`a = 1.867` — representative motorway values; adjust in `engine.py`.

## 2. METANET dynamics

Per segment, per time step `T` (10 s), with length `L` and lanes `λ_i`:

**Conservation** (on-ramp inflow adds, off-ramp split drains):
```
ρ_i(k+1) = ρ_i(k) + (T / (L·λ_i)) · [ q_in − q_i + r_i ]
```

**Speed** (relaxation toward equilibrium + convection + anticipation, with merge
and lane-drop terms):
```
v_i(k+1) = v_i(k)
         + (T/τ)·[V(ρ_i) − v_i]                          relaxation
         + (T/L)·v_i·[v_{i−1} − v_i]                     convection
         − (ν·T)/(τ·L) · (ρ_{i+1} − ρ_i)/(ρ_i + κ)       anticipation
         − (δ·T·r_i·v_i)/(L·λ_i·(ρ_i + κ))               ramp merge
         − (φ·T·Δλ·ρ_i·v_i²)/(L·λ_i·ρ_crit)              lane drop
```

Off-ramps are handled by draining the split fraction from a segment's **outflow**
(`q_next_i = q_i·(1 − β_i)`) rather than as a separate `−s_i` source term; the two
formulations are equivalent and conservative.

The mainline entry and every on-ramp are **origin queues**: demand that exceeds
what the downstream segment can receive waits in a queue rather than vanishing,
so you can see queues build and clear.

**Capacity drop.** Once a bottleneck segment is pushed past `ρ_crit`, its
discharge is capped at `(1 − c)·q_cap` (default `c = 0.13`). This reproduces the
observed 10–15 % drop in throughput when a bottleneck breaks down — the physical
reason ramp metering exists.

The 10 s step with ~0.5 km segments keeps the scheme comfortably stable
(the CFL-like limit is `T ≤ L / v_free`).

## 3. ALINEA (local feedback metering)

Each on-ramp runs an independent integral controller, updated every control
period:

```
r_j(k) = r_j(k−1) + K_R · ( ô − o_j(k) )
```

- `r_j` — metering rate (veh/h), clamped to `[r_min, r_max]`. The default
  `r_max = 1600 veh/h` assumes a multi-lane metered ramp; a single metered lane
  saturates nearer ~900 veh/h.
- `ô` — target occupancy (≈ critical), `o_j` — measured occupancy just downstream
  of ramp `j`.
- `K_R` — regulator gain (default 70 veh/h per %-occupancy).

Holding occupancy at `ô` keeps the merge on the free-flow branch. A local
override releases a ramp whose queue is about to overflow its storage.

## 4. HERO (coordinated metering)

Local ALINEA is greedy: the ramp nearest a bottleneck fills first and, once its
short storage overflows, is forced to release — while upstream ramps still had
spare storage. **HERO** keeps every ramp on ALINEA and adds coordination:

1. Compute each ramp's local ALINEA rate.
2. Scanning downstream → upstream, when an **active** bottleneck ramp
   (`o_j > ô`) has its queue fill exceed the *master* threshold, it **recruits**
   the nearest upstream ramp — reducing that ramp's rate so its queue fill catches
   up (balancing fill-ratios across the group).
3. Any ramp truly at its storage limit is released for safety.

The result: storage is shared across the ramp group, no single ramp overflows
onto the arterial, and the bottleneck stays protected longer. This is a
simplified, faithful-in-spirit version of the published HERO strategy
(Papamichail & Papageorgiou, 2010); it is not the exact operational algorithm.

## 5. Variable speed limits (VSL)

An optional second feedback loop lowers the posted speed limit on segments
upstream of the worst bottleneck when its occupancy exceeds target, metering the
mainline itself (Mainstream Traffic Flow Control). The reduced limit caps `V(ρ)`
via the fundamental diagram.

## 6. Demand calibration

For corridors with `"calibrate": true`, the app finds the segment with the
highest cumulative-demand / capacity ratio (the bottleneck) and scales all
demands so it sits ~22 % over capacity at demand level 100 % — a guaranteed
breakdown to study. Corridors with `"calibrate": false` use their demand numbers
verbatim (real data). See [INTEGRATION.md](INTEGRATION.md#4-real-vs-calibrated-demand).

## Why the numbers move

- **Mean speed** and **% time congested** are the most robust indicators of a
  metering benefit here — they improve clearly when a breakdown is prevented.
- **Total travel time (TTT)** is often close between strategies: metering moves
  delay from the mainline to the ramp queue, and over a full hour the queues
  clear, so vehicle-hours are roughly conserved *unless* a capacity drop is
  avoided (serving more vehicles during the peak) or VSL lowers the load into the
  bottleneck. This is a real, honest property of the model, not a bug.
- **HERO vs. local ALINEA** shows up mainly as *where* the queues sit: HERO
  spreads them upstream instead of overflowing the ramp nearest the bottleneck.

## Limitations

- Macroscopic and deterministic: no individual driver behaviour, incidents,
  weather, or stochastic demand. The animated vehicles are illustrative — the
  charts and readouts carry the exact model state.
- Single corridor, single direction; no network routing or route choice.
- The capacity-drop, merge and lane-drop terms are calibrated to representative
  values, not to a specific site. Fit them to local data for operational use.
- HERO is a simplified coordination heuristic, not a certified implementation.

## References

- Papageorgiou, Hadj-Salem & Blosseville (1991), TRR 1320.
- Kotsialos & Papageorgiou (2002), *METANET*, IEEE Trans. ITS 3(4).
- Papamichail & Papageorgiou (2010), *HERO*, TRR 2178.
- Faulkner, Dekker, Gyles, Papamichail & Papageorgiou (2014), TRR 2470.
