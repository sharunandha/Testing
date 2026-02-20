/**
 * Risk Engine: Flood & Landslide scoring (0-100) using prediction formulas.
 * Uses 24h/72h/7d rainfall, seismic, and state-based weighting for landslide.
 */

const { fetchRainfall } = require('./data_collection/openMeteoCollector');
const { fetchRecentEarthquakes } = require('./data_collection/usgsCollector');
const { fetchCombinedWaterLevels } = require('./data_collection/reservoirCollector');
const { matchReservoirToDam } = require('./utils/reservoirMatcher');
const { loadDams } = require('./analyticsEngine');
const { calculateAdvancedRisk, riskLevel } = require('./analyticsEngine');

const DEFAULT_THRESHOLDS = {
  flood: { low_max: 33, medium_max: 66, high_max: 100 },
  landslide: { low_max: 33, medium_max: 66, high_max: 100 }
};

function getLevel(score, thresholds) {
  return riskLevel(score);
}

function generateAlertMessage(alertLevel, floodScore, landslideScore) {
  if (alertLevel === 'NONE' || alertLevel === 'LOW') {
    return 'No significant disaster risk. Continue normal monitoring.';
  }
  if (alertLevel === 'MEDIUM') {
    return `Moderate risk: Flood ${floodScore}, Landslide ${landslideScore}. Stay alert and monitor updates.`;
  }
  return `High disaster risk: Flood ${floodScore}, Landslide ${landslideScore}. Take preventive actions and follow authorities.`;
}

function generateRecommendations(alertLevel) {
  if (alertLevel === 'HIGH') {
    return [
      'Evacuate low-lying and landslide-prone areas if advised',
      'Avoid crossing flooded roads and streams',
      'Follow instructions from disaster management authorities',
      'Keep emergency kit ready'
    ];
  }
  if (alertLevel === 'MEDIUM') {
    return [
      'Stay away from riverbanks and landslide-prone slopes',
      'Monitor weather and official advisories',
      'Be prepared to move to safer locations if conditions worsen'
    ];
  }
  return ['No special action required', 'Continue normal activities', 'Stay informed through official channels'];
}

/**
 * Run one full risk check using dam locations and new formulas.
 */
async function runRiskCheck(config) {
  const timestamp = new Date().toISOString();
  const assessmentId = `RISK_${timestamp.replace(/[-:T]/g, '').slice(0, 15)}`;

  const dams = loadDams();
  const locations = dams.length
    ? dams.slice(0, 25).map((d) => ({ id: d.id, name: d.name, state: d.state, lat: d.lat, lon: d.lon }))
    : (config.locations || [{ name: 'Chennai', lat: 13.0827, lon: 80.2707 }]);

  let rainfallData = [];
  let earthquakes = [];
  let reservoirLevels = [];

  try {
    [rainfallData, earthquakes] = await Promise.all([
      fetchRainfall(config, { locations, past_days: 7, forecast_days: 3 }),
      fetchRecentEarthquakes(config, 72)
    ]);
    reservoirLevels = await fetchCombinedWaterLevels(config);
  } catch (e) {
    return {
      assessment_id: assessmentId,
      timestamp,
      success: false,
      error: e.message,
      flood_risk_score: 0,
      landslide_risk_score: 0,
      overall_alert_level: 'LOW',
      alert_message: 'Data fetch failed. Retry later.',
      recommendations: ['Retry run check or check API connectivity.']
    };
  }

  const significantEq = earthquakes.filter((e) => e.magnitude >= 4.5);
  function eqNear(lat, lon) {
    return significantEq.filter(
      (e) => Math.abs(e.latitude - lat) <= 2 && Math.abs(e.longitude - lon) <= 2
    ).length;
  }

  let floodSum = 0;
  let landslideSum = 0;
  let confidenceSum = 0;
  let count = 0;
  const componentTotals = {
    flood: { intensity: 0, persistence: 0, saturation: 0, reservoir_stress: 0, anomaly: 0, seismic: 0, lowland_factor: 0 },
    landslide: { intensity: 0, duration: 0, terrain: 0, seismic: 0, anomaly: 0, reservoir_spill_stress: 0, prone_state_boost: 0 }
  };
  for (let i = 0; i < rainfallData.length; i++) {
    const rain = rainfallData[i];
    const dam = locations[i];
    if (!rain.summary) continue;
    const eq = dam ? eqNear(dam.lat, dam.lon) : 0;
    const reservoir = dam ? matchReservoirToDam(dam, reservoirLevels) : null;
    const advanced = calculateAdvancedRisk({
      rainSummary: rain.summary,
      rain72h: rain.summary.precipitation_sum_72h_mm,
      rain7d: rain.summary.precipitation_sum_7d_mm,
      earthquakesNearby: eq,
      elevation: rain.elevation_m,
      baselineAvgDaily: null,
      reservoirContext: reservoir,
      state: dam?.state
    });

    floodSum += advanced.flood_score;
    landslideSum += advanced.landslide_score;
    confidenceSum += advanced.confidence;

    Object.keys(componentTotals.flood).forEach((key) => {
      componentTotals.flood[key] += Number(advanced.components?.flood?.[key] || 0);
    });
    Object.keys(componentTotals.landslide).forEach((key) => {
      componentTotals.landslide[key] += Number(advanced.components?.landslide?.[key] || 0);
    });
    count++;
  }

  const floodScore = count ? Math.round(floodSum / count) : 0;
  const landslideScore = count ? Math.round(landslideSum / count) : 0;
  const modelConfidence = count ? Math.round(confidenceSum / count) : 0;

  const thresholds = config?.risk || DEFAULT_THRESHOLDS;
  const floodLevel = getLevel(floodScore, thresholds.flood);
  const landslideLevel = getLevel(landslideScore, thresholds.landslide);
  const overallScore = Math.max(floodScore, landslideScore);
  const overallLevel = getLevel(overallScore, thresholds.flood);
  const alertLevel = overallLevel;
  const alertMessage = generateAlertMessage(alertLevel, floodScore, landslideScore);
  const recommendations = generateRecommendations(alertLevel);

  return {
    assessment_id: assessmentId,
    timestamp,
    success: true,
    flood_risk_score: floodScore,
    landslide_risk_score: landslideScore,
    flood_risk_level: floodLevel,
    landslide_risk_level: landslideLevel,
    overall_alert_level: alertLevel,
    alert_message: alertMessage,
    recommendations,
    data_sources: {
      rainfall: 'Open-Meteo',
      earthquake: 'USGS',
      reservoir: reservoirLevels.length ? 'NWDP/Configured Open Source API' : 'Not configured'
    },
    summary: {
      rainfall_locations: rainfallData.length,
      earthquake_count: earthquakes.length,
      reservoir_count: reservoirLevels.length
    },
    model_diagnostics: {
      confidence: modelConfidence,
      averaged_components: {
        flood: Object.fromEntries(Object.entries(componentTotals.flood).map(([k, v]) => [k, count ? Math.round(v / count) : 0])),
        landslide: Object.fromEntries(Object.entries(componentTotals.landslide).map(([k, v]) => [k, count ? Math.round(v / count) : 0]))
      },
      notes: [
        'Scores use nonlinear fusion of rainfall intensity/persistence/saturation, seismic signal, terrain, and NWDP reservoir stress when matched.',
        'Confidence is based on feature completeness and source availability; it is not a historical accuracy metric.'
      ]
    },
    system_status: { last_update: timestamp }
  };
}

module.exports = {
  runRiskCheck,
  getLevel,
  generateAlertMessage,
  generateRecommendations
};
