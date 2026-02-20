# Environmental Monitoring & Geospatial Disaster Risk Analytics

Real-time **flood and landslide risk** dashboard and API, using the **same method** as the [India-specific Tsunami Early Warning System](https://github.com/sujin123456-max/India-specific-tsunami-early-warning-system): public APIs → scoring engine → REST API → web dashboard.

## Your project (from PDF)

- **Domain:** IoT, Environment & Disaster Risk Analysis  
- **Data:** Open-Meteo (rainfall), NASA POWER (historical climate), USGS (earthquakes), reservoir levels  
- **Output:** Risk scores 0–100, Low/Medium/High, real-time dashboard, India map (Green/Yellow/Red)  
- **Stack:** Node.js, Express, React, Leaflet, Chart.js  

## How it works (same as tsunami repo)

1. **Data collection** — Dedicated collectors call public APIs (Open-Meteo, USGS, etc.).
2. **Risk engine** — Combines rainfall, reservoir, and seismic data into flood and landslide scores (0–100) and alert level.
3. **REST API** — `GET /api/status`, `GET /api/current-assessment`, `POST /api/run-check`, monitoring start/stop, raw data endpoints.
4. **Dashboard** — Uses the API for real-time assessment, charts, and map.

## Quick start

```bash
npm install
npm start
```

- API: **http://localhost:5000**
- **Dashboard (light theme):** **http://localhost:5000/index.html** — state-wise dam monitor, high-risk zones, rainfall prediction, India map with risk markers.

## API endpoints (mirror tsunami repo)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | System status, last check, monitoring on/off |
| GET | `/api/current-assessment` | Latest flood/landslide assessment |
| POST | `/api/run-check` | Run one full cycle (fetch APIs → compute risk) |
| POST | `/api/monitoring/start` | Body: `{ "interval_seconds": 300 }` |
| POST | `/api/monitoring/stop` | Stop background monitoring |
| GET | `/api/rainfall` | Rainfall data (Open-Meteo) for charts |
| GET | `/api/earthquake/recent?hours=24&min_magnitude=5` | USGS earthquakes |
| GET | `/api/alert-history?hours=24` | Past assessments |
| GET | `/api/risk/info` | Thresholds and scoring description |
| GET | `/api/environment/overview` | Unified open-environment snapshot (weather, air, soil, UV + water summary) |
| GET | `/api/environment/sources` | Enabled/available open data sources |
| GET | `/api/water/reservoirs` | Reservoir levels from NWDP/India-WRIS-compatible + generic water APIs |

## Config

Edit `config/config.yaml`: API base URLs, India bounding box, risk thresholds (Low/Medium/High bands), and locations for rainfall.

- For official India water data, configure `apis.nwdp` with your NWDP endpoint + optional key/header mapping.
- Keep `apis.reservoir` as a fallback generic open-data JSON source.
- Default config now includes `apis.nwdp.mode: ckan_auto`, which auto-discovers NWDP reservoir datasets/resources and pulls latest records without manual field mapping.
- Smart station matching is enabled: NWDP station names are fuzzy-matched to your monitored dams (state + name similarity), and matched reservoir levels are used in flood-risk weighting.

## Analysis document

See **ANALYSIS_AND_IMPLEMENTATION_PLAN.md** for the full mapping of your PDF project to the tsunami repo’s method (APIs, calculations, and API design).

## Next steps

- Add a **React** frontend that consumes these endpoints and uses **Leaflet** (India map with Green/Yellow/Red markers) and **Chart.js** (rainfall and risk trends).
- Plug in a real **reservoir/dam API** when available and enable it in config.
- Optionally add **NASA POWER** collector for historical climate and refine scoring.

## Accuracy and comparison guidance

- This project now reports a **model confidence** score (data completeness/source coverage), but confidence is **not** forecast accuracy.
- True predictive accuracy vs an existing system requires historical labeled events (flood/landslide occurrences by date/location) and backtesting.
- Recommended metrics: Precision, Recall, F1, False Alarm Rate, Lead Time, and Brier Score.
- To compare fairly, run both models on the same historical periods and same dam/station set.
