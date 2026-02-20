/**
 * Open-Elevation API: get elevation (m) for lat,lon. Used for flood/landslide weighting.
 * Optional: if API fails, returns null; app continues with existing logic.
 */

const fetch = require('node-fetch');

const BASE = 'https://api.open-elevation.com/api/v1/lookup';

/** Get elevation in metres for one location. Returns null on failure. */
async function getElevation(lat, lon) {
  try {
    const url = `${BASE}?locations=${lat},${lon}`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results && data.results[0];
    return r && typeof r.elevation === 'number' ? r.elevation : null;
  } catch (e) {
    return null;
  }
}

/**
 * Get elevations for multiple locations. Returns Map keyed by "lat,lon" -> elevation (number or null).
 * Batches in chunks of 50 to avoid URL length limits.
 */
async function getElevations(locations) {
  const out = new Map();
  if (!locations || locations.length === 0) return out;

  const chunkSize = 50;
  for (let i = 0; i < locations.length; i += chunkSize) {
    const chunk = locations.slice(i, i + chunkSize);
    const locStr = chunk.map((l) => `${l.lat},${l.lon}`).join('|');
    try {
      const url = `${BASE}?locations=${encodeURIComponent(locStr)}`;
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) continue;
      const data = await res.json();
      const results = data.results || [];
      chunk.forEach((loc, idx) => {
        const r = results[idx];
        const key = `${loc.lat},${loc.lon}`;
        out.set(key, r && typeof r.elevation === 'number' ? r.elevation : null);
      });
    } catch (e) {
      chunk.forEach((loc) => out.set(`${loc.lat},${loc.lon}`, null));
    }
  }
  return out;
}

module.exports = { getElevation, getElevations };
