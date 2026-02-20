/**
 * Open environmental monitoring collector (open APIs only).
 * Sources:
 * - Open-Meteo forecast API (temperature, humidity, wind, pressure, precipitation, soil moisture, UV)
 * - Open-Meteo air-quality API (PM2.5, PM10, AQI, gases)
 */

const fetch = require('node-fetch');

const WEATHER_BASE = 'https://api.open-meteo.com/v1/forecast';
const AIR_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';

function avg(values) {
  const arr = (values || []).filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

async function fetchWeatherPoint(lat, lon, timeoutMs = 15000) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'auto',
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,surface_pressure,precipitation',
    hourly: 'soil_moisture_0_to_1cm,soil_moisture_1_to_3cm',
    daily: 'uv_index_max'
  });

  const res = await fetch(`${WEATHER_BASE}?${params.toString()}`, { timeout: timeoutMs });
  if (!res.ok) throw new Error(`Open-Meteo weather HTTP ${res.status}`);
  return res.json();
}

async function fetchAirPoint(lat, lon, timeoutMs = 15000) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'auto',
    current: 'pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi'
  });

  const res = await fetch(`${AIR_BASE}?${params.toString()}`, { timeout: timeoutMs });
  if (!res.ok) throw new Error(`Open-Meteo air HTTP ${res.status}`);
  return res.json();
}

function deriveLevel(value, thresholds) {
  if (value == null) return 'UNKNOWN';
  if (value <= thresholds.low) return 'LOW';
  if (value <= thresholds.medium) return 'MEDIUM';
  return 'HIGH';
}

async function fetchEnvironmentalOverview(config, options = {}) {
  const locations = options.locations || config?.locations || [];
  const sampleLimit = options.sample_limit || 12;
  const timeoutMs = config?.apis?.open_meteo?.timeout_ms || 15000;
  const selected = locations.slice(0, sampleLimit);

  if (!selected.length) {
    return {
      timestamp: new Date().toISOString(),
      source: ['Open-Meteo Weather', 'Open-Meteo Air Quality'],
      count: 0,
      locations: [],
      aggregates: {}
    };
  }

  const rows = await Promise.all(selected.map(async (loc) => {
    try {
      const [weather, air] = await Promise.all([
        fetchWeatherPoint(loc.lat, loc.lon, timeoutMs),
        fetchAirPoint(loc.lat, loc.lon, timeoutMs)
      ]);

      const currentW = weather.current || {};
      const currentA = air.current || {};
      const hourlyW = weather.hourly || {};
      const dailyW = weather.daily || {};

      const soilSurface = avg(hourlyW.soil_moisture_0_to_1cm || []);
      const soilShallow = avg(hourlyW.soil_moisture_1_to_3cm || []);
      const uvMax = avg((dailyW.uv_index_max || []).slice(0, 3));

      return {
        name: loc.name,
        state: loc.state || null,
        lat: loc.lat,
        lon: loc.lon,
        weather: {
          temperature_c: round(currentW.temperature_2m),
          humidity_pct: round(currentW.relative_humidity_2m),
          wind_kmh: round(currentW.wind_speed_10m),
          pressure_hpa: round(currentW.surface_pressure),
          precipitation_mm: round(currentW.precipitation)
        },
        soil: {
          moisture_0_1cm: round(soilSurface, 4),
          moisture_1_3cm: round(soilShallow, 4)
        },
        uv: {
          uv_index_max_3d_avg: round(uvMax)
        },
        air: {
          pm2_5: round(currentA.pm2_5),
          pm10: round(currentA.pm10),
          us_aqi: round(currentA.us_aqi),
          european_aqi: round(currentA.european_aqi),
          ozone: round(currentA.ozone),
          no2: round(currentA.nitrogen_dioxide),
          so2: round(currentA.sulphur_dioxide),
          co: round(currentA.carbon_monoxide)
        },
        source: ['Open-Meteo Weather', 'Open-Meteo Air Quality']
      };
    } catch (error) {
      return {
        name: loc.name,
        state: loc.state || null,
        lat: loc.lat,
        lon: loc.lon,
        error: error.message,
        source: ['Open-Meteo Weather', 'Open-Meteo Air Quality']
      };
    }
  }));

  const ok = rows.filter((r) => !r.error);

  const aggregates = {
    temperature_c_avg: round(avg(ok.map((r) => r.weather.temperature_c))),
    humidity_pct_avg: round(avg(ok.map((r) => r.weather.humidity_pct))),
    wind_kmh_avg: round(avg(ok.map((r) => r.weather.wind_kmh))),
    pm2_5_avg: round(avg(ok.map((r) => r.air.pm2_5))),
    pm10_avg: round(avg(ok.map((r) => r.air.pm10))),
    us_aqi_avg: round(avg(ok.map((r) => r.air.us_aqi))),
    soil_moisture_surface_avg: round(avg(ok.map((r) => r.soil.moisture_0_1cm)), 4),
    uv_index_max_3d_avg: round(avg(ok.map((r) => r.uv.uv_index_max_3d_avg))),
    heat_level: deriveLevel(avg(ok.map((r) => r.weather.temperature_c)), { low: 30, medium: 37 }),
    air_quality_level: deriveLevel(avg(ok.map((r) => r.air.us_aqi)), { low: 50, medium: 100 }),
    drought_signal_level: deriveLevel(avg(ok.map((r) => r.soil.moisture_0_1cm)), { low: 0.15, medium: 0.3 })
  };

  return {
    timestamp: new Date().toISOString(),
    source: ['Open-Meteo Weather', 'Open-Meteo Air Quality'],
    count: ok.length,
    locations: rows,
    aggregates
  };
}

module.exports = { fetchEnvironmentalOverview };
