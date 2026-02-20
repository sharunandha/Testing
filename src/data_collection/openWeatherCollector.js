/**
 * OpenWeatherMap API: second source for rainfall. Optional – requires api_key in config.
 * If key missing or API fails, returns null; app uses only Open-Meteo (no collapse).
 */

const fetch = require('node-fetch');

const BASE = 'https://api.openweathermap.org/data/2.5';

/**
 * Fetch 5-day forecast (3h steps) – free tier. Sum rain for next 24h and max 3h step.
 * Returns { precipitation_sum_24h_mm, max_hourly_precipitation_mm } or null.
 */
async function fetchRainfallAtPoint(lat, lon, apiKey) {
  if (!apiKey || !lat || lon === undefined) return null;
  try {
    const res = await fetch(
      `${BASE}/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`,
      { timeout: 10000 }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const list = data.list || [];
    let sum24 = 0;
    let max3h = 0;
    for (let i = 0; i < Math.min(8, list.length); i++) {
      const rain = (list[i].rain && list[i].rain['3h']) || 0;
      sum24 += rain;
      if (rain > max3h) max3h = rain;
    }
    return {
      precipitation_sum_24h_mm: Math.round(sum24 * 100) / 100,
      max_hourly_precipitation_mm: Math.round((max3h / 3) * 100) / 100
    };
  } catch (e) {
    return null;
  }
}

/**
 * Fetch rainfall for multiple locations. Returns array same length as locations;
 * each element is summary object or null if fetch failed.
 */
async function fetchRainfallForLocations(locations, apiKey) {
  if (!apiKey || !locations || locations.length === 0) return locations.map(() => null);
  const results = await Promise.all(
    locations.map((loc) => fetchRainfallAtPoint(loc.lat, loc.lon, apiKey))
  );
  return results;
}

module.exports = { fetchRainfallAtPoint, fetchRainfallForLocations };
