/**
 * REST API Routes - Same pattern as India-specific-tsunami-early-warning-system api_routes.py
 * status, current-assessment, run-check, monitoring/start|stop, raw data, alert-history, risk/info
 */

const express = require('express');
const router = express.Router();
const { runRiskCheck } = require('../riskEngine');
const { fetchRainfall } = require('../data_collection/openMeteoCollector');
const { fetchRecentEarthquakes } = require('../data_collection/usgsCollector');
const { fetchEnvironmentalOverview } = require('../data_collection/environmentCollector');
const { fetchCombinedWaterLevels } = require('../data_collection/reservoirCollector');
const {
  loadDams,
  getDamsByState,
  getStates,
  runFullAnalytics,
  getRainfallPrediction
} = require('../analyticsEngine');
const { runOneHourNowcast } = require('../nowcastEngine');

let currentAssessment = null;
let lastCheckTime = null;
let isMonitoring = false;
let monitoringInterval = null;
let checkIntervalSeconds = 300;
let alertHistory = [];
const MAX_HISTORY = 100;

function getConfig(req) {
  return req.app.get('config') || {};
}

// ---- Status (same as tsunami GET /api/status) ----
router.get('/status', (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        is_monitoring: isMonitoring,
        last_check: lastCheckTime,
        check_interval_seconds: checkIntervalSeconds,
        current_assessment: currentAssessment ? { ...currentAssessment } : null,
        system_time: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Current assessment (same as tsunami GET /api/current-assessment) ----
router.get('/current-assessment', (req, res) => {
  try {
    if (!currentAssessment) {
      return res.json({
        success: true,
        data: { message: 'No assessment available yet', run_check: true }
      });
    }
    res.json({ success: true, data: currentAssessment });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Run check (same as tsunami POST /api/run-check) ----
router.post('/run-check', async (req, res) => {
  try {
    const config = getConfig(req);
    const assessment = await runRiskCheck(config);
    currentAssessment = assessment;
    lastCheckTime = new Date().toISOString();
    if (assessment.assessment_id) {
      alertHistory.unshift(assessment);
      if (alertHistory.length > MAX_HISTORY) alertHistory.pop();
    }
    res.json({ success: true, data: assessment });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Monitoring start/stop (same as tsunami) ----
router.post('/monitoring/start', (req, res) => {
  try {
    const body = req.body || {};
    const interval = body.interval_seconds ?? checkIntervalSeconds;
    checkIntervalSeconds = interval;

    if (monitoringInterval) clearInterval(monitoringInterval);

    const config = getConfig(req);
    monitoringInterval = setInterval(async () => {
      if (!isMonitoring) return;
      try {
        const assessment = await runRiskCheck(config);
        currentAssessment = assessment;
        lastCheckTime = new Date().toISOString();
        if (assessment.assessment_id) {
          alertHistory.unshift(assessment);
          if (alertHistory.length > MAX_HISTORY) alertHistory.pop();
        }
      } catch (e) {
        console.error('Monitoring run check error:', e.message);
      }
    }, interval * 1000);
    isMonitoring = true;

    res.json({
      success: true,
      message: `Monitoring started with ${interval}s interval`,
      data: { interval_seconds: interval }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

router.post('/monitoring/stop', (req, res) => {
  try {
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    isMonitoring = false;
    res.json({ success: true, message: 'Monitoring stopped' });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Raw data for dashboard (same idea as tsunami /api/earthquake/recent, /api/ocean/conditions) ----
router.get('/rainfall', async (req, res) => {
  try {
    const config = getConfig(req);
    const data = await fetchRainfall(config);
    res.json({
      success: true,
      data: {
        rainfall: data,
        source: 'Open-Meteo',
        timestamp: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

router.get('/water/reservoirs', async (req, res) => {
  try {
    const config = getConfig(req);
    const stateFilter = String(req.query.state || '').trim().toLowerCase();
    let levels = await fetchCombinedWaterLevels(config);
    if (stateFilter) {
      levels = levels.filter((row) => String(row.state || '').trim().toLowerCase() === stateFilter);
    }
    res.json({
      success: true,
      data: {
        source: ['NWDP/India-WRIS compatible API', 'Configured reservoir API'],
        count: levels.length,
        levels,
        timestamp: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

router.get('/environment/overview', async (req, res) => {
  try {
    const config = getConfig(req);
    const state = req.query.state || null;
    const sampleLimit = parseInt(req.query.sample_limit, 10) || 12;
    const dams = state ? getDamsByState(state) : loadDams();
    const locations = dams.length
      ? dams.slice(0, sampleLimit).map((d) => ({ name: d.name, state: d.state, lat: d.lat, lon: d.lon }))
      : (config.locations || []).slice(0, sampleLimit);

    const environment = await fetchEnvironmentalOverview(config, { locations, sample_limit: sampleLimit });
    const water = await fetchCombinedWaterLevels(config);

    res.json({
      success: true,
      data: {
        ...environment,
        water: {
          source: ['NWDP/India-WRIS compatible API', 'Configured reservoir API'],
          count: water.length,
          reservoirs_over_75pct: water.filter((w) => w.level_pct >= 75).length,
          reservoirs_over_90pct: water.filter((w) => w.level_pct >= 90).length
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

router.get('/environment/sources', (req, res) => {
  const config = getConfig(req);
  const sources = [
    { id: 'open_meteo', label: 'Open-Meteo Weather', enabled: true, type: 'weather' },
    { id: 'open_meteo_air', label: 'Open-Meteo Air Quality', enabled: true, type: 'air_quality' },
    { id: 'usgs_earthquake', label: 'USGS Earthquake', enabled: true, type: 'seismic' },
    {
      id: 'nasa_power',
      label: 'NASA POWER',
      enabled: config?.apis?.nasa_power?.enabled !== false,
      type: 'climate_baseline'
    },
    {
      id: 'open_elevation',
      label: 'Open-Elevation',
      enabled: config?.apis?.open_elevation?.enabled !== false,
      type: 'terrain'
    },
    {
      id: 'nwdp',
      label: 'NWDP / India-WRIS compatible water API',
      enabled: !!(config?.apis?.nwdp?.enabled && config?.apis?.nwdp?.base_url),
      type: 'water_levels'
    },
    {
      id: 'reservoir_generic',
      label: 'Generic Reservoir API',
      enabled: !!(config?.apis?.reservoir?.enabled && config?.apis?.reservoir?.base_url),
      type: 'water_levels'
    }
  ];
  res.json({ success: true, data: { sources, timestamp: new Date().toISOString() } });
});

router.get('/earthquake/recent', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const minMagnitude = parseFloat(req.query.min_magnitude) || 4.0;
    const config = getConfig(req);
    let earthquakes = await fetchRecentEarthquakes(config, hours);
    earthquakes = earthquakes.filter((e) => e.magnitude >= minMagnitude);
    res.json({
      success: true,
      data: { count: earthquakes.length, earthquakes }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Alert history (same as tsunami GET /api/alert-history) ----
router.get('/alert-history', (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const alerts = alertHistory.filter((a) => a.timestamp >= cutoff);
    res.json({ success: true, data: { count: alerts.length, alerts } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Risk info (thresholds, formulas) ----
router.get('/risk/info', (req, res) => {
  try {
    const config = getConfig(req);
    const risk = config.risk || {};
    res.json({
      success: true,
      data: {
        flood_thresholds: risk.flood || { low_max: 33, medium_max: 66, high_max: 100 },
        landslide_thresholds: risk.landslide || { low_max: 33, medium_max: 66, high_max: 100 },
        flood_formula: 'sigmoid(0.30*intensity_24h + 0.18*persistence_72h + 0.14*saturation_7d + 0.14*reservoir_stress + 0.10*rain_anomaly + 0.08*seismic + 0.06*lowland_factor)',
        landslide_formula: 'sigmoid(0.27*intensity + 0.24*duration_72h + 0.16*terrain + 0.10*seismic + 0.10*rain_anomaly + 0.07*reservoir_spill + 0.06*prone_state_boost)',
        description: 'Advanced nonlinear flood/landslide risk scores 0-100; Low (0-33), Medium (34-66), High (67-100). Reservoir stress is sourced from NWDP/generic APIs when match is available.',
        confidence_note: 'Model confidence indicates feature/source completeness, not historical forecast accuracy.'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Dams: list all or filter by state ----
router.get('/dams', (req, res) => {
  try {
    const state = req.query.state || null;
    const dams = state ? getDamsByState(state) : loadDams();
    res.json({ success: true, data: { dams, state_filter: state || null, count: dams.length } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

router.get('/states', (req, res) => {
  try {
    const states = getStates();
    res.json({ success: true, data: { states } });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- High-risk zones and full analytics ----
router.get('/risk/zones', async (req, res) => {
  try {
    const config = getConfig(req);
    const state = req.query.state || null;
    const analytics = await runFullAnalytics(config, state);
    res.json({
      success: true,
      data: {
        high_risk_zones: analytics.high_risk_zones,
        by_state: analytics.by_state,
        timestamp: analytics.timestamp
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Rainfall prediction (average next 7 days by state) ----
router.get('/rainfall/prediction', async (req, res) => {
  try {
    const config = getConfig(req);
    const state = req.query.state || null;
    const pred = await getRainfallPrediction(config, state);
    res.json({ success: true, data: pred });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- Full analytics: dams with risk, state-wise, high-risk zones, prediction ----
router.get('/analytics', async (req, res) => {
  try {
    const config = getConfig(req);
    const state = req.query.state || null;
    const analytics = await runFullAnalytics(config, state);
    res.json({ success: true, data: analytics });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

// ---- 1-Hour Nowcast Early Warning ----
router.get('/nowcast/1h', async (req, res) => {
  try {
    const config = getConfig(req);
    const state = req.query.state || null;
    const nowcast = await runOneHourNowcast(config, state);
    res.json({ success: true, data: nowcast });
  } catch (e) {
    console.error('Nowcast error:', e.message);
    res.status(500).json({ success: false, error: String(e.message) });
  }
});

module.exports = router;
