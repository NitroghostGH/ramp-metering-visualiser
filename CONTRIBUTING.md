# Contributing

Thanks for your interest! This project is a self-contained Django + vanilla-JS
app with no build step.

## Development setup

```bash
pip install -r requirements.txt
python manage.py test        # run the suite
python manage.py runserver   # http://127.0.0.1:8000/
```

## Guidelines

- **Keep it dependency-light.** The server is Django + the standard library; the
  frontend is vanilla JS with `<canvas>` and Leaflet (from a CDN). Please don't
  add a build toolchain or heavy runtime dependencies without discussion.
- **Match the surrounding style.** Small, focused functions; comments explain
  *why*, not *what*.
- **Add tests** for engine or API changes (`simulator/tests.py`,
  `python manage.py test`).
- **Be honest in the model.** If a change makes results look better, make sure
  it's physically justified and note assumptions in `docs/MODEL.md`. Don't tune
  numbers just to flatter a strategy.
- **New corridors** go in `simulator/data/corridors/` as JSON (see
  `docs/INTEGRATION.md`). Clearly mark approximated data with
  `"representative": true`.

## Good first contributions

- Real OpenStreetMap-derived geometry for a corridor.
- Additional ramp-metering strategies (e.g. PI-ALINEA, queue-adjusted variants).
- Observed detector data overlays on the charts for model validation.
- Export of simulation results (CSV/JSON) from the UI.

## Reporting issues

Include the corridor, the parameter values, and what you expected vs. saw.
Screenshots of the schematic or charts help a lot.
