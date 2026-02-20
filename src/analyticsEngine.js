/**
 * Analytics Engine: Dams, high-risk zones, rainfall prediction, state-wise monitoring.
 * Prediction formulas for flood and landslide from API data only.
 */

const path = require('path');
const fs = require('fs');
const { fetchRainfall } = require('./data_collection/openMeteoCollector');
const { fetchRecentEarthquakes } = require('./data_collection/usgsCollector');
const { getElevations } = require('./data_collection/openElevationCollector');
const { getRecentBaselineCached } = require('./data_collection/nasaPowerCollector');
const { fetchRainfallForLocations } = require('./data_collection/openWeatherCollector');
const { fetchCombinedWaterLevels } = require('./data_collection/reservoirCollector');
const { matchReservoirToDam } = require('./utils/reservoirMatcher');

let damsCache = null;

function loadDams() {
  if (damsCache) return damsCache;
  const p = path.join(process.cwd(), 'data', 'dams.json');
  if (!fs.existsSync(p)) return [];
  damsCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  return damsCache;
}

function getDamsByState(state) {
  const dams = loadDams();
  if (!state) return dams;
  const s = String(state).trim().toLowerCase();
  return dams.filter((d) => (d.state || '').toLowerCase() === s);
}

function getStates() {
  const dams = loadDams();
  const set = new Set(dams.map((d) => d.state).filter(Boolean));
  return [...set].sort();
}

// ---- Flood Risk Index (0-100) ----
// Formula: intensity (24h), persistence (72h), saturation (7d), seismic; optional elevation + NASA baseline.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNum(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sigmoidTo100(value, center = 50, steepness = 0.08) {
  const z = steepness * (value - center);
  return 100 / (1 + Math.exp(-z));
}

function normalizeReservoirLevel(levelPct) {
  const level = safeNum(levelPct, NaN);
  if (!Number.isFinite(level)) return null;
  if (level >= 0 && level <= 1) return level * 100;
  if (level >= 0 && level <= 100) return level;
  return null;
}

function reservoirStressIndex(reservoirContext = {}) {
  const levelPct = normalizeReservoirLevel(reservoirContext.level_pct);
  const inflow = safeNum(reservoirContext.inflow, NaN);
  const outflow = safeNum(reservoirContext.outflow, NaN);

  const levelStress = levelPct == null ? null : clamp((levelPct - 60) * 2.5, 0, 100);
  let flowStress = null;
  if (Number.isFinite(inflow) && Number.isFinite(outflow) && outflow >= 0) {
    const ratio = inflow / (outflow + 1e-6);
    flowStress = clamp((ratio - 1) * 45 + 50, 0, 100);
  }

  if (levelStress == null && flowStress == null) return 0;
  if (levelStress != null && flowStress != null) return Math.round(0.7 * levelStress + 0.3 * flowStress);
  return Math.round(levelStress ?? flowStress ?? 0);
}

function calculateAdvancedRisk(input = {}) {
  const rainSummary = input.rainSummary || {};
  const r24 = safeNum(rainSummary.precipitation_sum_24h_mm);
  const r72 = safeNum(input.rain72h ?? rainSummary.precipitation_sum_72h_mm ?? r24);
  const r7 = safeNum(input.rain7d ?? rainSummary.precipitation_sum_7d_mm ?? r72);
  const peak = safeNum(rainSummary.max_hourly_precipitation_mm);
  const earthquakesNearby = safeNum(input.earthquakesNearby);
  const elevation = Number.isFinite(Number(input.elevation)) ? Number(input.elevation) : null;
  const baselineAvgDaily = Number.isFinite(Number(input.baselineAvgDaily)) ? Number(input.baselineAvgDaily) : null;
  const state = (input.state || '').toLowerCase();
  const reservoirContext = input.reservoirContext || {};

  const intensityFlood = clamp((r24 / 1.25) + (peak * 2.8), 0, 100);
  const persistence = clamp((r72 / 2.0), 0, 100);
  const saturation = clamp((r7 / 3.6), 0, 100);
  const seismic = clamp(earthquakesNearby * 18, 0, 100);
  const anomalyRatio = baselineAvgDaily && baselineAvgDaily > 0 ? (r24 / 24) / baselineAvgDaily : 1;
  const anomaly = clamp((anomalyRatio - 1) * 50 + 50, 0, 100);
  const reservoirStress = reservoirStressIndex(reservoirContext);
  const lowlandFactor = elevation == null ? 0 : (elevation < 300 ? 12 : elevation < 600 ? 6 : 0);

  const floodLinear =
    0.30 * intensityFlood +
    0.18 * persistence +
    0.14 * saturation +
    0.14 * reservoirStress +
    0.10 * anomaly +
    0.08 * seismic +
    0.06 * lowlandFactor;
  const floodScore = Math.round(clamp(sigmoidTo100(floodLinear, 50, 0.09), 0, 100));

  const intensityLand = clamp((r24 / 1.15) + (peak * 3.1), 0, 100);
  const durationLand = clamp((r72 / 1.8), 0, 100);
  const seismicLand = clamp(earthquakesNearby * 20, 0, 100);
  const terrain = elevation == null ? 50 : clamp((elevation / 30), 0, 100);
  const proneStateBoost = LANDSLIDE_PRONE_STATES.has(state) ? 12 : 0;
  const spillSlopeStress = clamp(reservoirStress * 0.55, 0, 100);

  const landslideLinear =
    0.27 * intensityLand +
    0.24 * durationLand +
    0.16 * terrain +
    0.10 * seismicLand +
    0.10 * anomaly +
    0.07 * spillSlopeStress +
    0.06 * proneStateBoost;
  const landslideScore = Math.round(clamp(sigmoidTo100(landslideLinear, 48, 0.085), 0, 100));

  const featuresAvailable = [
    r24 > 0,
    r72 > 0,
    r7 > 0,
    peak >= 0,
    earthquakesNearby >= 0,
    elevation != null,
    baselineAvgDaily != null,
    normalizeReservoirLevel(reservoirContext.level_pct) != null
  ];
  const completeness = featuresAvailable.filter(Boolean).length / featuresAvailable.length;
  const sourceDiversity = 3 + (baselineAvgDaily != null ? 1 : 0) + (normalizeReservoirLevel(reservoirContext.level_pct) != null ? 1 : 0);
  const confidence = Math.round(clamp(45 + completeness * 40 + sourceDiversity * 3, 0, 100));

  return {
    flood_score: floodScore,
    landslide_score: landslideScore,
    confidence,
    components: {
      flood: {
        intensity: Math.round(intensityFlood),
        persistence: Math.round(persistence),
        saturation: Math.round(saturation),
        reservoir_stress: Math.round(reservoirStress),
        anomaly: Math.round(anomaly),
        seismic: Math.round(seismic),
        lowland_factor: Math.round(lowlandFactor)
      },
      landslide: {
        intensity: Math.round(intensityLand),
        duration: Math.round(durationLand),
        terrain: Math.round(terrain),
        seismic: Math.round(seismicLand),
        anomaly: Math.round(anomaly),
        reservoir_spill_stress: Math.round(spillSlopeStress),
        prone_state_boost: Math.round(proneStateBoost)
      }
    }
  };
}

function floodRiskScore(rainSummary, rain72h, rain7d, earthquakesNearby, elevation, baselineAvgDaily, reservoirContext = null, state = null) {
  return calculateAdvancedRisk({
    rainSummary,
    rain72h,
    rain7d,
    earthquakesNearby,
    elevation,
    baselineAvgDaily,
    reservoirContext,
    state
  }).flood_score;
}

// ---- Landslide Risk Index (0-100) ----
// Formula: rainfall intensity + duration (72h) + seismic (M>=4.5). Hill regions weighted higher via state tag.
const LANDSLIDE_PRONE_STATES = new Set([
  'kerala', 'uttarakhand', 'himachal pradesh', 'assam', 'tamil nadu', 'maharashtra', 'karnataka', 'goa', 'meghalaya', 'arunachal pradesh', 'mizoram', 'nagaland', 'manipur', 'jammu and kashmir', 'sikkim', 'west bengal'
]);

function landslideRiskScore(rainSummary, rain72h, earthquakesNearby, state) {
  return calculateAdvancedRisk({
    rainSummary,
    rain72h,
    earthquakesNearby,
    state
  }).landslide_score;
}

function riskLevel(score) {
  if (score <= 33) return 'LOW';
  if (score <= 66) return 'MEDIUM';
  return 'HIGH';
}

/**
 * Run full analytics: fetch rainfall at all dam locations (batch in chunks to avoid rate limit),
 * earthquakes India, then compute per-dam and per-state risk, high-risk zones, and rainfall prediction.
 */
const MAX_DAMS_ALL_INDIA = 35;

async function runFullAnalytics(config, stateFilter = null) {
  let dams = stateFilter ? getDamsByState(stateFilter) : loadDams();
  if (!stateFilter && dams.length > MAX_DAMS_ALL_INDIA) dams = dams.slice(0, MAX_DAMS_ALL_INDIA);
  if (dams.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      state_filter: stateFilter,
      dams: [],
      by_state: {},
      high_risk_zones: [],
      rainfall_prediction: {},
      earthquakes: [],
      formula: {
        flood: '0.35*intensity_24h + 0.30*persistence_72h + 0.25*saturation_7d + 0.10*seismic',
        landslide: '0.50*intensity + 0.35*duration_72h + 0.15*seismic; 1.2x in landslide-prone states'
      }
    };
  }

  const locations = dams.map((d) => ({
    id: d.id,
    name: d.name,
    state: d.state,
    lat: d.lat,
    lon: d.lon
  }));

  const apis = config?.apis || {};
  const openElevationEnabled = apis.open_elevation?.enabled !== false;
  const openWeatherEnabled = apis.open_weather?.enabled && apis.open_weather?.api_key;
  const nasaPowerEnabled = apis.nasa_power?.enabled !== false;

  const [rainfallData, earthquakes, elevationsMap, openWeatherRain, baselineSample, reservoirLevels] = await Promise.all([
    fetchRainfall(config, { locations, past_days: 7, forecast_days: 7 }),
    fetchRecentEarthquakes(config, 72),
    openElevationEnabled ? getElevations(locations) : Promise.resolve(new Map()),
    openWeatherEnabled ? fetchRainfallForLocations(locations, apis.open_weather.api_key) : Promise.resolve([]),
    nasaPowerEnabled && locations.length > 0
      ? Promise.all(locations.slice(0, 3).map((l) => getRecentBaselineCached(l.lat, l.lon)))
          .then((arr) => { const valid = arr.filter((v) => v != null); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; })
          .catch(() => null)
      : Promise.resolve(null),
    fetchCombinedWaterLevels(config)
  ]);

  const significantEq = earthquakes.filter((e) => e.magnitude >= 4.5);
  function eqCountNear(lat, lon, radiusDeg) {
    return significantEq.filter((e) =>
      Math.abs(e.latitude - lat) <= radiusDeg && Math.abs(e.longitude - lon) <= radiusDeg
    ).length;
  }

  const damResults = [];
  const byState = {};

  for (let i = 0; i < dams.length; i++) {
    const dam = dams[i];
    const rain = rainfallData[i] || {};
    let summary = rain.summary;
    const state = dam.state || 'Unknown';
    if (!byState[state]) byState[state] = { dams: [], flood_scores: [], landslide_scores: [], rainfall_24h: [], rainfall_pred_avg: 0, count: 0 };

    if (summary && openWeatherRain[i]) {
      const ow = openWeatherRain[i];
      summary = {
        ...summary,
        precipitation_sum_24h_mm: (summary.precipitation_sum_24h_mm + ow.precipitation_sum_24h_mm) / 2,
        max_hourly_precipitation_mm: Math.max(summary.max_hourly_precipitation_mm || 0, ow.max_hourly_precipitation_mm || 0)
      };
    }
    const elevKey = `${dam.lat},${dam.lon}`;
    const elevation = elevationsMap.get && elevationsMap.get(elevKey) != null ? elevationsMap.get(elevKey) : rain.elevation_m;

    const eqNear = eqCountNear(dam.lat, dam.lon, 2);
    const matchedReservoir = matchReservoirToDam(dam, reservoirLevels);
    const advanced = summary ? calculateAdvancedRisk({
      rainSummary: summary,
      rain72h: summary.precipitation_sum_72h_mm,
      rain7d: summary.precipitation_sum_7d_mm,
      earthquakesNearby: eqNear,
      elevation,
      baselineAvgDaily: baselineSample,
      reservoirContext: matchedReservoir,
      state
    }) : { flood_score: 0, landslide_score: 0, confidence: 0, components: { flood: {}, landslide: {} } };
    let floodScore = advanced.flood_score;
    let landslideScore = advanced.landslide_score;
    const cal = config?.risk?.calibration;
    if (cal) {
      if (typeof cal.flood_multiplier === 'number') floodScore = Math.round(Math.min(100, floodScore * cal.flood_multiplier));
      if (typeof cal.landslide_multiplier === 'number') landslideScore = Math.round(Math.min(100, landslideScore * cal.landslide_multiplier));
    }

    const forecastDaily = rain.forecast_daily || [];
    const predAvg = forecastDaily.length ? forecastDaily.reduce((a, d) => a + (d.precipitation_mm || 0), 0) / forecastDaily.length : 0;

    damResults.push({
      ...dam,
      rainfall_24h_mm: summary?.precipitation_sum_24h_mm ?? null,
      rainfall_72h_mm: summary?.precipitation_sum_72h_mm ?? null,
      rainfall_7d_mm: summary?.precipitation_sum_7d_mm ?? null,
      flood_risk_score: floodScore,
      landslide_risk_score: landslideScore,
      flood_risk_level: riskLevel(floodScore),
      landslide_risk_level: riskLevel(landslideScore),
      predicted_avg_rainfall_7d_mm: Math.round(predAvg * 100) / 100,
      forecast_daily: forecastDaily.slice(0, 7),
      earthquakes_nearby: eqNear,
      model_confidence: advanced.confidence,
      model_components: advanced.components,
      reservoir_level_pct: matchedReservoir?.level_pct ?? null,
      reservoir_match_name: matchedReservoir?.name ?? null,
      reservoir_match_score: matchedReservoir?.match_score ?? null
    });

    byState[state].dams.push(dam.name);
    byState[state].flood_scores.push(floodScore);
    byState[state].landslide_scores.push(landslideScore);
    byState[state].rainfall_24h.push(summary?.precipitation_sum_24h_mm ?? 0);
    byState[state].rainfall_pred_avg += predAvg;
    byState[state].count += 1;
  }

  Object.keys(byState).forEach((st) => {
    const s = byState[st];
    const n = s.count || 1;
    s.flood_avg = Math.round(s.flood_scores.reduce((a, b) => a + b, 0) / n);
    s.landslide_avg = Math.round(s.landslide_scores.reduce((a, b) => a + b, 0) / n);
    s.rainfall_24h_avg = Math.round((s.rainfall_24h.reduce((a, b) => a + b, 0) / n) * 100) / 100;
    s.rainfall_pred_avg = Math.round((s.rainfall_pred_avg / n) * 100) / 100;
    s.flood_level = riskLevel(s.flood_avg);
    s.landslide_level = riskLevel(s.landslide_avg);
  });

  /* Build risk zones per-dam (not state average) so individual MEDIUM/HIGH dams always appear */
  const high_risk_zones = damResults
    .filter(d => d.flood_risk_level !== 'LOW' || d.landslide_risk_level !== 'LOW')
    .map(d => ({
      dam: d.name,
      state: d.state,
      flood_risk: d.flood_risk_score,
      landslide_risk: d.landslide_risk_score,
      flood_level: d.flood_risk_level,
      landslide_level: d.landslide_risk_level,
      zone_severity: (d.flood_risk_level === 'HIGH' || d.landslide_risk_level === 'HIGH') ? 'HIGH' : 'MEDIUM'
    }))
    .sort((a, b) => {
      if (a.zone_severity === 'HIGH' && b.zone_severity !== 'HIGH') return -1;
      if (b.zone_severity === 'HIGH' && a.zone_severity !== 'HIGH') return 1;
      return Math.max(b.flood_risk, b.landslide_risk) - Math.max(a.flood_risk, a.landslide_risk);
    });

  const rainfall_prediction = {};
  Object.entries(byState).forEach(([state, v]) => {
    rainfall_prediction[state] = {
      avg_24h_mm: v.rainfall_24h_avg,
      predicted_avg_7d_mm: v.rainfall_pred_avg
    };
  });

  return {
    timestamp: new Date().toISOString(),
    state_filter: stateFilter || null,
    dams: damResults,
    by_state: byState,
    high_risk_zones,
    rainfall_prediction,
    earthquakes: significantEq.slice(0, 20),
    formula: {
      flood: '0.35*intensity_24h + 0.30*persistence_72h + 0.25*saturation_7d + 0.10*seismic',
      landslide: '0.50*intensity + 0.35*duration_72h + 0.15*seismic; 1.2x in landslide-prone states'
    }
  };
}

/**
 * Average rainfall prediction (next 7 days) - India or state level.
 */
async function getRainfallPrediction(config, stateFilter = null) {
  const analytics = await runFullAnalytics(config, stateFilter);
  return {
    timestamp: analytics.timestamp,
    by_state: analytics.rainfall_prediction,
    high_risk_zones: analytics.high_risk_zones
  };
}

module.exports = {
  loadDams,
  getDamsByState,
  getStates,
  runFullAnalytics,
  getRainfallPrediction,
  calculateAdvancedRisk,
  floodRiskScore,
  landslideRiskScore,
  riskLevel
};
