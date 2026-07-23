"""Unit + API tests. Run: python manage.py test"""
import json

from django.test import SimpleTestCase, Client

from . import corridors
from .engine import Physics, Simulation


class CorridorLoaderTests(SimpleTestCase):
    def test_examples_load(self):
        ids = [c["id"] for c in corridors.list_corridors()]
        self.assertIn("pacific_m3", ids)
        self.assertTrue(all("route" in c for c in corridors.list_corridors()))

    def test_build_shapes(self):
        c = corridors.build("pacific_m3")
        n = c["n_segments"]
        self.assertEqual(len(c["lanes"]), n)
        self.assertEqual(len(c["vlimit"]), n)
        self.assertTrue(0 <= c["bottleneck_seg"] < n)
        self.assertTrue(len(c["on_ramps"]) >= 1)

    def test_unknown_corridor_falls_back(self):
        c = corridors.build("does-not-exist")
        self.assertEqual(c["id"], corridors.default_id())

    def test_calibrate_flag(self):
        # a non-calibrated corridor keeps demand scale at 1.0
        c = corridors.build("pacific_m3")  # calibrate: true -> scaled
        self.assertNotEqual(c["demand_scale"], 1.0)


class EngineTests(SimpleTestCase):
    def setUp(self):
        self.c = corridors.build("bruce_m1")

    def test_runs_and_is_finite(self):
        r = Simulation(self.c, Physics(), 1.0, "hero", False).run()
        n = len(r["t"])
        self.assertEqual(len(r["seg_v"]), n)
        for row in r["seg_v"]:
            for v in row:
                self.assertTrue(0 <= v < 500)  # no blow-up / NaN

    def test_metering_helps_or_neutral(self):
        base = Simulation(self.c, Physics(), 1.0, "none", False).run()
        hero = Simulation(self.c, Physics(), 1.0, "hero", False).run()
        # HERO should never make mean speed materially worse
        self.assertGreaterEqual(hero["mean_speed"], base["mean_speed"] - 0.5)

    def test_demand_profile(self):
        prof = {"time_s": [0, 3600],
                "mainline": [self.c["mainline_demand"]] * 2,
                "ramps": [[o["demand"], o["demand"]] for o in self.c["on_ramps"]]}
        r = Simulation(self.c, Physics(), 1.0, "none", False, demand_profile=prof).run()
        self.assertEqual(len(r["t"]), int(round(Physics().horizon / Physics().T)))


class ApiTests(SimpleTestCase):
    def setUp(self):
        self.client = Client()

    def test_index_ok(self):
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_corridors_endpoint(self):
        data = self.client.get("/api/corridors").json()
        self.assertIn("corridors", data)
        self.assertTrue(len(data["corridors"]) >= 1)

    def test_simulate_returns_all_scenarios(self):
        resp = self.client.post("/api/simulate",
                                data=json.dumps({"corridor": "pacific_m3"}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 200)
        results = resp.json()["results"]
        for key in ("none", "alinea", "hero", "none_vsl", "alinea_vsl", "hero_vsl"):
            self.assertIn(key, results)

    def test_simulate_rejects_bad_profile(self):
        bad = {"corridor": "pacific_m3",
               "demand_profile": {"time_s": [0, 0], "mainline": [1, 2], "ramps": []}}
        resp = self.client.post("/api/simulate", data=json.dumps(bad),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 400)
