/**
 * USGS Earthquake Data Collector
 * Fetches recent earthquakes from USGS API (India bounding box).
 * Same pattern as India-specific-tsunami-early-warning-system usgs_collector.py
 */

const fetch = require('node-fetch');

const DEFAULT_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

function formatTime(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * @param {Object} config - config.apis.usgs_earthquake
 * @param {number} [hours] - lookback hours (default from config)
 * @returns {Promise<Array<{ id, magnitude, depth, latitude, longitude, time, place, type }>>}
 */
async function fetchRecentEarthquakes(config, hours = null) {
  const apiConfig = config?.apis?.usgs_earthquake || {};
  const baseUrl = apiConfig.base_url || DEFAULT_BASE;
  const lookback = hours ?? apiConfig.lookback_hours ?? 24;
  const minMag = apiConfig.min_magnitude ?? 4.0;
  const region = apiConfig.region || {
    min_latitude: 6,
    max_latitude: 36,
    min_longitude: 68,
    max_longitude: 98
  };

  const end = new Date();
  const start = new Date(end.getTime() - lookback * 60 * 60 * 1000);

  const params = new URLSearchParams({
    format: apiConfig.format || 'geojson',
    starttime: formatTime(start),
    endtime: formatTime(end),
    minmagnitude: String(minMag),
    minlatitude: String(region.min_latitude),
    maxlatitude: String(region.max_latitude),
    minlongitude: String(region.min_longitude),
    maxlongitude: String(region.max_longitude),
    orderby: 'time-asc'
  });

  try {
    const res = await fetch(`${baseUrl}?${params}`, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    return features.map((f) => {
      const props = f.properties || {};
      const coords = (f.geometry && f.geometry.coordinates) || [0, 0, 0];
      return {
        id: f.id,
        magnitude: props.mag,
        depth: coords[2],
        latitude: coords[1],
        longitude: coords[0],
        time: new Date(props.time).toISOString(),
        place: props.place || '',
        type: props.type || 'earthquake',
        tsunami: props.tsunami || 0
      };
    });
  } catch (err) {
    return [];
  }
}

module.exports = { fetchRecentEarthquakes };
