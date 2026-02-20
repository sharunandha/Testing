/**
 * Open-Meteo Rainfall Data Collector
 * Fetches real-time and forecast precipitation. Supports 24h, 72h, 7d and forecast for prediction.
 */

const fetch = require('node-fetch');

const DEFAULT_BASE = 'https://api.open-meteo.com/v1/forecast';

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

/**
 * Fetch rainfall for given locations with optional past_days and forecast_days.
 * Returns 24h, 72h, 7d sums and daily forecast for average rainfall prediction.
 */
async function fetchRainfall(config, options = {}) {
  const apiConfig = config?.apis?.open_meteo || {};
  const locations = options.locations || config?.locations || [{ name: 'Chennai', lat: 13.0827, lon: 80.2707 }];
  const baseUrl = apiConfig.base_url || DEFAULT_BASE;
  const pastDays = options.past_days ?? apiConfig.past_days ?? 1;
  const forecastDays = Math.min(16, options.forecast_days ?? apiConfig.forecast_days ?? 7);
  const parallelRequests = Math.max(4, Math.min(20, apiConfig.parallel_requests || 10));

  const results = [];

  async function fetchLocation(loc) {
    try {
      const params = new URLSearchParams({
        latitude: String(loc.lat),
        longitude: String(loc.lon),
        hourly: 'precipitation,rain,precipitation_probability',
        daily: 'precipitation_sum',
        past_days: String(Math.min(7, pastDays)),
        forecast_days: String(forecastDays)
      });
      const url = `${baseUrl}?${params}`;
      const res = await fetch(url, { timeout: 20000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const hourly = data.hourly || {};
      const daily = data.daily || {};
      const times = hourly.time || [];
      const precip = (hourly.precipitation || []).map(Number);
      const rain = (hourly.rain || []).map(Number);

      const n = precip.length;
      const last24h = n >= 24 ? precip.slice(-24) : precip;
      const last72h = n >= 72 ? precip.slice(-72) : precip;
      const last7d = precip;

      const sum24h = sum(last24h);
      const sum72h = sum(last72h);
      const sum7d = sum(last7d);
      const maxHourly = Math.max(0, ...precip);

      const dailyDates = daily.time || [];
      const dailySums = (daily.precipitation_sum || []).map(Number);

      return {
        name: loc.name,
        state: loc.state,
        id: loc.id,
        lat: loc.lat,
        lon: loc.lon,
        hourly: { time: times, precipitation: precip, rain },
        summary: {
          precipitation_sum_24h_mm: Math.round(sum24h * 100) / 100,
          precipitation_sum_72h_mm: Math.round(sum72h * 100) / 100,
          precipitation_sum_7d_mm: Math.round(sum7d * 100) / 100,
          max_hourly_precipitation_mm: Math.round(maxHourly * 100) / 100,
          unit: 'mm'
        },
        forecast_daily: dailyDates.map((d, i) => ({
          date: d,
          precipitation_mm: dailySums[i] != null ? dailySums[i] : 0
        })),
        elevation_m: data.elevation,
        source: 'Open-Meteo'
      };
    } catch (err) {
      /* Retry once after short delay */
      try {
        await new Promise(r => setTimeout(r, 1500));
        const params2 = new URLSearchParams({
          latitude: String(loc.lat),
          longitude: String(loc.lon),
          hourly: 'precipitation',
          daily: 'precipitation_sum',
          past_days: String(Math.min(7, pastDays)),
          forecast_days: String(forecastDays)
        });
        const res2 = await fetch(`${baseUrl}?${params2}`, { timeout: 25000 });
        if (!res2.ok) throw new Error(`Retry HTTP ${res2.status}`);
        const data2 = await res2.json();
        const precip2 = (data2.hourly?.precipitation || []).map(Number);
        const n2 = precip2.length;
        return {
          name: loc.name, state: loc.state, id: loc.id, lat: loc.lat, lon: loc.lon,
          hourly: { time: data2.hourly?.time || [], precipitation: precip2, rain: [] },
          summary: {
            precipitation_sum_24h_mm: Math.round(sum(n2 >= 24 ? precip2.slice(-24) : precip2) * 100) / 100,
            precipitation_sum_72h_mm: Math.round(sum(n2 >= 72 ? precip2.slice(-72) : precip2) * 100) / 100,
            precipitation_sum_7d_mm: Math.round(sum(precip2) * 100) / 100,
            max_hourly_precipitation_mm: Math.round(Math.max(0, ...precip2) * 100) / 100,
            unit: 'mm'
          },
          forecast_daily: (data2.daily?.time || []).map((d, i) => ({
            date: d, precipitation_mm: (data2.daily?.precipitation_sum || [])[i] || 0
          })),
          elevation_m: data2.elevation,
          source: 'Open-Meteo (retry)'
        };
      } catch (_) {
        return {
          name: loc.name, state: loc.state, id: loc.id, lat: loc.lat, lon: loc.lon,
          error: err.message,
          summary: { precipitation_sum_24h_mm: 0, precipitation_sum_72h_mm: 0, precipitation_sum_7d_mm: 0, max_hourly_precipitation_mm: 0, unit: 'mm' },
          forecast_daily: [],
          source: 'Open-Meteo (fallback)'
        };
      }
    }
  }

  for (let i = 0; i < locations.length; i += parallelRequests) {
    const chunk = locations.slice(i, i + parallelRequests);
    const chunkResults = await Promise.all(chunk.map((loc) => fetchLocation(loc)));
    chunkResults.forEach((r) => results.push(r));
  }

  return results;
}

module.exports = { fetchRainfall, sum };
