const { fetchRainfall } = require('./data_collection/openMeteoCollector');
const { fetchRecentEarthquakes } = require('./data_collection/usgsCollector');
const { fetchCombinedWaterLevels } = require('./data_collection/reservoirCollector');
const { matchReservoirToDam } = require('./utils/reservoirMatcher');
const { loadDams, getDamsByState, calculateAdvancedRisk, riskLevel } = require('./analyticsEngine');

const scoreHistory = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function updateHistory(damId, score, maxPoints = 8) {
  const existing = scoreHistory.get(damId) || [];
  const next = [...existing, { score, ts: Date.now() }].slice(-maxPoints);
  scoreHistory.set(damId, next);
  return next;
}

function consecutiveRising(history) {
  if (!history || history.length < 2) return 0;
  let rising = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].score > history[i - 1].score) rising += 1;
    else break;
  }
  return rising;
}

function rainfallWindows(hourly = {}) {
  const times = hourly.time || [];
  const precip = (hourly.precipitation || []).map((v) => toNumber(v));
  if (!times.length || !precip.length) {
    return { next1h_mm: 0, next3h_mm: 0, past6h_mm: 0, accel_mm: 0 };
  }

  const now = Date.now();
  const paired = times.map((t, i) => ({ ts: Date.parse(t), p: precip[i] || 0 })).filter((x) => Number.isFinite(x.ts));
  if (!paired.length) return { next1h_mm: 0, next3h_mm: 0, past6h_mm: 0, accel_mm: 0 };

  const next = paired.filter((x) => x.ts >= now).sort((a, b) => a.ts - b.ts);
  const past = paired.filter((x) => x.ts < now).sort((a, b) => b.ts - a.ts);

  const next1h = next.slice(0, 1).reduce((a, b) => a + b.p, 0);
  const next3h = next.slice(0, 3).reduce((a, b) => a + b.p, 0);
  const prev3h = past.slice(0, 3).reduce((a, b) => a + b.p, 0);
  const past6h = past.slice(0, 6).reduce((a, b) => a + b.p, 0);
  const accel = Math.max(0, next3h - prev3h);

  return {
    next1h_mm: Math.round(next1h * 100) / 100,
    next3h_mm: Math.round(next3h * 100) / 100,
    past6h_mm: Math.round(past6h * 100) / 100,
    accel_mm: Math.round(accel * 100) / 100
  };
}

function normalizeRain(value, scale) {
  return clamp((toNumber(value) / scale) * 100, 0, 100);
}

function oneHourScores(advanced, rainWin, modelConfidence, elevation, reservoirLevelPct) {
  const next1h = normalizeRain(rainWin.next1h_mm, 25);
  const next3h = normalizeRain(rainWin.next3h_mm, 55);
  const past6h = normalizeRain(rainWin.past6h_mm, 70);
  const accel = normalizeRain(rainWin.accel_mm, 30);
  const terrain = elevation == null ? 50 : clamp((toNumber(elevation) / 30), 0, 100);
  const reservoirStress = reservoirLevelPct == null ? 0 : clamp((toNumber(reservoirLevelPct) - 60) * 2.5, 0, 100);

  const flood1h = clamp(
    0.34 * toNumber(advanced.flood_score) +
    0.26 * next1h +
    0.16 * next3h +
    0.10 * past6h +
    0.08 * accel +
    0.06 * reservoirStress,
    0,
    100
  );

  const landslide1h = clamp(
    0.32 * toNumber(advanced.landslide_score) +
    0.22 * next1h +
    0.15 * next3h +
    0.10 * accel +
    0.11 * terrain +
    0.10 * (100 - clamp(modelConfidence, 0, 100)) * 0.2,
    0,
    100
  );

  return {
    flood_score_1h: Math.round(flood1h),
    landslide_score_1h: Math.round(landslide1h)
  };
}

async function runOneHourNowcast(config, stateFilter = null) {
  const nowcastCfg = config?.risk?.nowcast || {};
  const warningThreshold = nowcastCfg.warning_threshold ?? 60;
  const emergencyThreshold = nowcastCfg.emergency_threshold ?? 75;
  const risingChecks = nowcastCfg.rising_checks ?? 3;

  let dams = stateFilter ? getDamsByState(stateFilter) : loadDams();
  if (!stateFilter && dams.length > 35) dams = dams.slice(0, 35);

  if (!dams.length) {
    return {
      timestamp: new Date().toISOString(),
      state_filter: stateFilter,
      dams: [],
      warning_count: 0,
      emergency_count: 0,
      alert_level_1h: 'LOW'
    };
  }

  const locations = dams.map((d) => ({ id: d.id, name: d.name, state: d.state, lat: d.lat, lon: d.lon }));

  const [rainfallData, earthquakes, reservoirLevels] = await Promise.all([
    fetchRainfall(config, { locations, past_days: 1, forecast_days: 2 }),
    fetchRecentEarthquakes(config, 24),
    fetchCombinedWaterLevels(config)
  ]);

  const significantEq = earthquakes.filter((e) => e.magnitude >= 4.5);
  const eqNear = (lat, lon) => significantEq.filter((e) => Math.abs(e.latitude - lat) <= 2 && Math.abs(e.longitude - lon) <= 2).length;

  const results = [];

  for (let i = 0; i < dams.length; i++) {
    const dam = dams[i];
    const rain = rainfallData[i] || {};
    if (!rain.summary) continue;

    const matchedReservoir = matchReservoirToDam(dam, reservoirLevels);
    const advanced = calculateAdvancedRisk({
      rainSummary: rain.summary,
      rain72h: rain.summary.precipitation_sum_72h_mm,
      rain7d: rain.summary.precipitation_sum_7d_mm,
      earthquakesNearby: eqNear(dam.lat, dam.lon),
      elevation: rain.elevation_m,
      baselineAvgDaily: null,
      reservoirContext: matchedReservoir,
      state: dam.state
    });

    const rainWin = rainfallWindows(rain.hourly);
    const oneHour = oneHourScores(
      advanced,
      rainWin,
      advanced.confidence,
      rain.elevation_m,
      matchedReservoir?.level_pct ?? null
    );

    const overall1h = Math.max(oneHour.flood_score_1h, oneHour.landslide_score_1h);
    const history = updateHistory(dam.id || dam.name, overall1h);
    const rising = consecutiveRising(history);

    const warningTriggered = overall1h >= warningThreshold && rising >= risingChecks;
    const emergencyTriggered = overall1h >= emergencyThreshold && rising >= Math.max(1, risingChecks - 1);

    results.push({
      id: dam.id,
      name: dam.name,
      state: dam.state,
      flood_score_1h: oneHour.flood_score_1h,
      landslide_score_1h: oneHour.landslide_score_1h,
      overall_score_1h: overall1h,
      risk_level_1h: riskLevel(overall1h),
      warning_triggered: warningTriggered,
      emergency_triggered: emergencyTriggered,
      rising_checks: rising,
      hourly_windows_mm: rainWin,
      model_confidence: advanced.confidence,
      reservoir_level_pct: matchedReservoir?.level_pct ?? null,
      reservoir_match_name: matchedReservoir?.name ?? null
    });
  }

  const warningCount = results.filter((r) => r.warning_triggered).length;
  const emergencyCount = results.filter((r) => r.emergency_triggered).length;

  let alertLevel = 'LOW';
  if (emergencyCount > 0) alertLevel = 'HIGH';
  else if (warningCount > 0) alertLevel = 'MEDIUM';

  return {
    timestamp: new Date().toISOString(),
    state_filter: stateFilter || null,
    thresholds: {
      warning_threshold: warningThreshold,
      emergency_threshold: emergencyThreshold,
      rising_checks: risingChecks
    },
    warning_count: warningCount,
    emergency_count: emergencyCount,
    alert_level_1h: alertLevel,
    dams: results.sort((a, b) => b.overall_score_1h - a.overall_score_1h)
  };
}

module.exports = { runOneHourNowcast };
