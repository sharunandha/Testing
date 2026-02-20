/**
 * NASA POWER API: historical/climatology precipitation for baseline comparison.
 * Optional: if API fails or is slow, returns null; app continues without baseline.
 * Used to compare "current rain vs normal" for better flood/landslide weighting.
 */

const fetch = require('node-fetch');

const BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';

/**
 * Get average daily precipitation (mm) for a location over a date range (baseline).
 * Returns { avgDailyPrecipMm, days } or null on failure.
 */
async function getBaselinePrecipitation(lat, lon, startDate, endDate) {
  try {
    const params = new URLSearchParams({
      parameters: 'PRECTOTCORR',
      community: 'AG',
      longitude: String(lon),
      latitude: String(lat),
      start: startDate,
      end: endDate,
      format: 'JSON'
    });
    const res = await fetch(`${BASE}?${params}`, { timeout: 20000 });
    if (!res.ok) return null;
    const data = await res.json();
    const props = data.properties || {};
    const param = props.parameter || {};
    const precip = param.PRECTOTCORR || {};
    const values = Object.values(precip).filter((v) => typeof v === 'number');
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return { avgDailyPrecipMm: sum / values.length, days: values.length };
  } catch (e) {
    return null;
  }
}

/**
 * Get baseline for last 30 days (recent normal). Used to scale current rain.
 * Returns number (avg mm/day) or null.
 */
async function getRecentBaseline(lat, lon) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const result = await getBaselinePrecipitation(lat, lon, fmt(start), fmt(end));
  return result ? result.avgDailyPrecipMm : null;
}

/** In-memory cache: key = "lat,lon", value = { avg, ts }; TTL 24h so we don't hammer NASA. */
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getRecentBaselineCached(lat, lon) {
  const key = `${lat},${lon}`;
  const now = Date.now();
  const c = cache.get(key);
  if (c && now - c.ts < CACHE_TTL_MS) return c.avg;
  const avg = await getRecentBaseline(lat, lon);
  cache.set(key, { avg, ts: now });
  return avg;
}

module.exports = { getBaselinePrecipitation, getRecentBaseline, getRecentBaselineCached };
