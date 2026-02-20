# Analysis: Your Project vs Tsunami Repo Method

## 1. Your Project (from PDF)

**Title:** Environmental Monitoring and Geospatial Disaster Risk Analytics System with Real-Time Web-Based Dashboard

**Scope:**
- **Domain:** IoT, Environment & Disaster Risk Analysis
- **Data sources:** Public APIs — Open-Meteo (rainfall), NASA POWER (historical climate), USGS (earthquakes), reservoir level data
- **Risks:** Flood and landslide (scoring 0–100, levels: Low / Medium / High)
- **Output:** Real-time dashboard, interactive India map (Green/Yellow/Red), dam status, rainfall trends, alerts
- **Stack (from PDF):** Node.js & Express.js, React.js, Leaflet.js, Chart.js, External APIs

---

## 2. Tsunami Repo Method (How It Gets APIs and Calculations)

### 2.1 Architecture (Same Pattern to Reuse)

```
DATA COLLECTION LAYER  →  PREPROCESSING  →  RISK ENGINE (scoring/filter)  →  REST API  →  DASHBOARD
```

- **Data collection:** Dedicated collector modules that call public APIs with config (base URL, params, region, lookback). Example: `USGSEarthquakeCollector` calls `earthquake.usgs.gov/fdsnws/event/1/query` with `format`, `starttime`, `endtime`, `minmagnitude`, bounding box.
- **Real-time:** Data is fetched on a schedule (e.g. every 5 min) or on-demand via “run check”. No API keys for USGS/NOAA; optional keys only where needed.
- **Calculation:** A **risk engine** (inference + filter + risk assessor) combines:
  - Raw API outputs (magnitude, depth, location, ocean readings)
  - Predefined scoring/threshold logic (e.g. tsunami-capable: M≥6.5, depth &lt; 70 km)
  - Optional ML model (tsunami repo uses CNN-LSTM); your project can use **scoring-based algorithms** only, as in your PDF
- **REST API:** Same pattern:
  - `GET /api/status` — system state, last check, monitoring on/off
  - `GET /api/current-assessment` — latest risk assessment (alert level, score, message, recommendations)
  - `POST /api/run-check` — trigger one full cycle (fetch APIs → compute risk → store as current assessment)
  - `POST /api/monitoring/start` (body: `interval_seconds`) / `POST /api/monitoring/stop`
  - `GET /api/<data-type>/...` — raw or processed data (e.g. earthquakes, ocean conditions)
  - `GET /api/alert-history?hours=24`
  - Optional: `GET /api/model/info` or `/api/risk/info` (thresholds, formula description)
- **Dashboard:** Single-page app that polls or uses the above API to show real-time assessment, maps, and charts.

### 2.2 How Tsunami Repo Gets APIs and Calculations

| Step | What it does |
|------|----------------|
| **APIs** | USGS (earthquakes), NOAA (tides, buoys), INCOIS (advisories). Each has a collector class that uses `requests.get(url, params=...)` with time range and region. |
| **Calculation** | 1) Fetch earthquakes → filter significant (e.g. M≥6.5). 2) Fetch ocean data → anomaly detection. 3) Optional: run CNN-LSTM model. 4) India filter (distance to coast, propagation). 5) Risk assessor: map risk score to alert level (NONE/WATCH/ADVISORY/WARNING), generate message and recommendations. |
| **Real-time** | Background loop runs `run_tsunami_check()` every N seconds; result is stored as `current_assessment`; API returns that object. |

---

## 3. Mapping Tsunami Method → Your Project

### 3.1 Data Sources (Your APIs)

| Your PDF source | Role in calculation | Collector responsibility |
|-----------------|---------------------|---------------------------|
| **Open-Meteo** | Live rainfall → flood/landslide input | GET hourly/daily precipitation for Indian regions/stations. No key. Base: `https://api.open-meteo.com/v1/forecast` and/or `v1/history`. |
| **NASA POWER** | Historical climate (e.g. soil moisture, precipitation normals) | GET temporal/climatology for lat/lon and date range. Base: `https://power.larc.nasa.gov/api/temporal/...`. |
| **USGS** | Earthquakes → landslide/seismic trigger | Reuse same pattern as tsunami repo: `earthquake.usgs.gov/fdsnws/event/1/query` with India bounding box. |
| **Reservoir level** | Dam overflow → flood risk | Either a public API (e.g. CWC/state dashboards) or mock/sample until you have a stable source. |

### 3.2 Calculation (Real-Time Analysis) — Same Idea as Tsunami

- **Single “run check” cycle:**
  1. **Fetch:** Call Open-Meteo (rainfall), NASA POWER (if needed for baseline), USGS (recent earthquakes), reservoir API.
  2. **Score flood risk (0–100):** Use predefined logic, e.g.:
     - Rainfall intensity/duration (from Open-Meteo)
     - Reservoir level vs capacity (if available)
     - Weights and thresholds you define (e.g. heavy rain + high reservoir → higher score).
  3. **Score landslide risk (0–100):** e.g.:
     - Rainfall + slope/soil (NASA POWER or static layers)
     - Seismic activity (USGS) as trigger
  4. **Combine/classify:** Overall or per-region score 0–100 → Low (e.g. 0–33), Medium (34–66), High (67–100). Optionally one combined “disaster risk” score.
  5. **Output:** One **current assessment** object: `assessment_id`, `timestamp`, `flood_risk_score`, `landslide_risk_score`, `alert_level`, `affected_regions`, `alert_message`, `recommendations`, `data_sources`.

- **Real-time:** Same as tsunami: either a background job that runs this cycle every N minutes and stores the result, or on-demand via `POST /api/run-check`. Dashboard uses `GET /api/current-assessment`.

### 3.3 REST API (Mirror Tsunami Repo)

| Endpoint | Purpose |
|----------|--------|
| `GET /api/status` | `is_monitoring`, `last_check`, `check_interval_seconds`, `current_assessment` (or ref), `system_time` |
| `GET /api/current-assessment` | Latest flood/landslide assessment (scores, alert level, message, recommendations) |
| `POST /api/run-check` | Run one full cycle (fetch all APIs → compute scores → update and return assessment) |
| `POST /api/monitoring/start` | Body: `{ "interval_seconds": 300 }` — start background loop |
| `POST /api/monitoring/stop` | Stop background loop |
| `GET /api/rainfall` or `/api/weather` | Raw/processed Open-Meteo rainfall for dashboard charts |
| `GET /api/earthquake/recent?hours=24&min_magnitude=5` | USGS earthquakes (reuse tsunami pattern) |
| `GET /api/reservoir` | Reservoir/dam levels if you have a source |
| `GET /api/alert-history?hours=24` | Past assessments/alerts |
| `GET /api/risk/info` | Describe thresholds and scoring (e.g. how 0–100 is computed) |

### 3.4 Dashboard (Your Stack)

- **React** — SPA that calls the above API.
- **Leaflet** — India map with color-coded markers (Green/Yellow/Red) by risk level (reuse idea from tsunami repo’s “affected regions” and map markers).
- **Chart.js** — Rainfall trends, time series of risk scores (data from `/api/rainfall` and `/api/current-assessment` / `alert-history`).

So: **same method** — backend owns APIs and calculations; frontend only consumes the REST API for real-time analysis display.

---

## 4. Exact Repo Method in Short

1. **Config:** Central config (e.g. `config/config.yaml` or `.env`) for API base URLs, India bounding box, risk thresholds (e.g. score bands for Low/Medium/High), and monitoring interval.
2. **Collectors:** One module per source (Open-Meteo, NASA POWER, USGS, reservoir) that exports a function like `fetchRainfall(region, hours)` or `fetchRecentEarthquakes(hours)` and returns normalized JSON.
3. **Risk engine:** One module that:
   - Runs all fetches,
   - Applies your scoring formulas (0–100 for flood and landslide),
   - Maps to Low/Medium/High and generates message and recommendations,
   - Returns the single “assessment” object.
4. **API layer:** Express routes that:
   - Call the risk engine on `POST /api/run-check` and optionally from a timer,
   - Expose `GET /api/current-assessment`, `GET /api/status`, monitoring start/stop, and raw data endpoints.
5. **Frontend:** React app that polls or refreshes on `GET /api/current-assessment` and related endpoints, and renders map (Leaflet) and charts (Chart.js).

This gives you **exactly the same method** as the tsunami repo: APIs and calculations in one place (backend), real-time analysis exposed via REST, and a web dashboard that only consumes that API.

---

## 5. Next Steps in This Repo

- Add **backend** (Node.js + Express): config, collectors (Open-Meteo, NASA POWER, USGS, reservoir stub), risk engine (0–100 scoring, alert levels), and REST routes as above.
- Add **frontend** (React + Leaflet + Chart.js): dashboard page, map with risk markers, charts for rainfall and risk over time, using only the new API.
- Optionally add **monitoring loop** (setInterval or job) that calls the same “run check” logic every N minutes so the dashboard stays real-time without manual “Run check”.

Once this structure is in place, you can plug in real reservoir APIs or replace scoring with a simple ML model later without changing the API or dashboard contract.
