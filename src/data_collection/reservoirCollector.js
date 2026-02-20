/**
 * Reservoir / Dam Level Collector (open/public sources)
 * Supports:
 * 1) Generic reservoir API via apis.reservoir
 * 2) NWDP / India-WRIS style API via apis.nwdp (official India water portal paths)
 * Returns normalized records and source labels.
 */

const fetch = require('node-fetch');

const nwdpAutoCache = {
  ts: 0,
  ttlMs: 15 * 60 * 1000,
  data: []
};

function normalizeLevel(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  return data.dams || data.reservoirs || data.data || data.items || [];
}

function mapRecord(item, mappings = {}) {
  const nameField = mappings.name || 'name';
  const levelField = mappings.level_pct || 'level_pct';
  const capacityField = mappings.capacity || 'capacity';
  const statusField = mappings.status || 'status';
  const stateField = mappings.state || 'state';
  const inflowField = mappings.inflow || 'inflow';
  const outflowField = mappings.outflow || 'outflow';
  const storageField = mappings.storage || 'storage';
  const updatedAtField = mappings.updated_at || 'updated_at';

  return {
    name: item[nameField] || item.dam_name || item.id || item.station_name || '—',
    level_pct: normalizeLevel(item[levelField] ?? item.storage_pct ?? item.level ?? item.percentage),
    capacity: item[capacityField],
    status: item[statusField],
    state: item[stateField],
    inflow: item[inflowField],
    outflow: item[outflowField],
    storage: item[storageField],
    updated_at: item[updatedAtField] || item.observation_time || item.timestamp
  };
}

function pickField(record, candidates = []) {
  if (!record || typeof record !== 'object') return undefined;
  const keys = Object.keys(record);
  for (const candidate of candidates) {
    const direct = keys.find((k) => k.toLowerCase() === candidate.toLowerCase());
    if (direct) return record[direct];
  }
  for (const candidate of candidates) {
    const partial = keys.find((k) => k.toLowerCase().includes(candidate.toLowerCase()));
    if (partial) return record[partial];
  }
  return undefined;
}

function parseLevelPct(record) {
  const percentCandidates = ['level_pct', 'storage_pct', 'percent', 'percentage', 'live_storage_percent', 'gross_storage_percent'];

  const pctRaw = pickField(record, percentCandidates);
  const pct = normalizeLevel(pctRaw);
  if (pct != null) {
    if (pct >= 0 && pct <= 100) return pct;
    if (pct > 0 && pct <= 1) return Math.round(pct * 10000) / 100;
  }

  /* Try to compute percentage from storage / capacity */
  const storageCandidates = ['live_storage', 'storage', 'gross_storage', 'current_storage'];
  const capacityCandidates = ['capacity', 'gross_capacity', 'full_reservoir_level', 'frl'];
  const storageVal = normalizeLevel(pickField(record, storageCandidates));
  const capacityVal = normalizeLevel(pickField(record, capacityCandidates));
  if (storageVal != null && capacityVal != null && capacityVal > 0) {
    const computed = Math.round((storageVal / capacityVal) * 10000) / 100;
    if (computed >= 0 && computed <= 150) return Math.min(computed, 100);
  }

  /* Do NOT treat raw water level (meters) as percentage – too unreliable */
  return null;
}

async function fetchNwdpAutoLevels(appConfig) {
  const apiConfig = appConfig?.apis?.nwdp || {};
  const now = Date.now();
  const ttl = apiConfig.cache_ttl_ms || nwdpAutoCache.ttlMs;
  if (nwdpAutoCache.data.length && now - nwdpAutoCache.ts < ttl) {
    return nwdpAutoCache.data;
  }

  const base = (apiConfig.ckan_base_url || 'https://nwdp.nwic.gov.in').replace(/\/$/, '');
  const searchQuery = apiConfig.search_query || 'reservoir water level';
  const searchRows = apiConfig.search_rows || 80;
  const maxResources = apiConfig.max_resources || 120;
  const parallelRequests = Math.max(4, Math.min(20, apiConfig.parallel_requests || 12));
  const timeout = apiConfig.timeout_ms || 12000;

  const searchUrl = `${base}/api/3/action/package_search?q=${encodeURIComponent(searchQuery)}&rows=${encodeURIComponent(String(searchRows))}`;
  const searchRes = await fetch(searchUrl, { timeout });
  if (!searchRes.ok) return [];
  const searchJson = await searchRes.json();
  const packages = searchJson?.result?.results || [];

  const resources = [];
  for (const pkg of packages) {
    for (const r of (pkg.resources || [])) {
      if (!r.datastore_active) continue;
      resources.push({
        resourceId: r.id,
        resourceName: r.name || '',
        packageTitle: pkg.title || pkg.name || '',
        packageName: pkg.name || '',
        stateHint: pkg.organization?.title || pkg.organization?.name || null
      });
      if (resources.length >= maxResources) break;
    }
    if (resources.length >= maxResources) break;
  }

  const rows = [];
  for (let i = 0; i < resources.length; i += parallelRequests) {
    const chunk = resources.slice(i, i + parallelRequests);
    const chunkRows = await Promise.all(chunk.map(async (resource) => {
      try {
        const dsUrl = `${base}/api/3/action/datastore_search?resource_id=${encodeURIComponent(resource.resourceId)}&limit=1&sort=_id%20desc`;
        const res = await fetch(dsUrl, { timeout });
        if (!res.ok) return null;
        const json = await res.json();
        const record = json?.result?.records?.[0];
        if (!record) return null;

        let name = pickField(record, ['dam_name', 'reservoir_name', 'station_name', 'station', 'project_name', 'name'])
          || resource.resourceName
          || resource.packageTitle;
        /* Clean station codes like RL1700_BBMB, _1, _2, ARG etc. from display name */
        name = String(name || '').replace(/[_\s]*(RL\d+|BBMB|ARG|CWC|_\d+)\b/gi, '').replace(/_+/g, ' ').trim();
        const state = pickField(record, ['state', 'state_name']) || resource.stateHint;
        const inflow = pickField(record, ['inflow', 'in_flow']);
        const outflow = pickField(record, ['outflow', 'out_flow']);
        const storage = pickField(record, ['storage', 'live_storage', 'gross_storage']);
        const capacity = pickField(record, ['capacity', 'gross_capacity']);
        const updatedAt = pickField(record, ['date', 'datetime', 'observation_time', 'timestamp', 'updated_at']);

        return {
          name: String(name || '—').trim(),
          level_pct: parseLevelPct(record),
          capacity,
          status: 'active',
          state,
          inflow,
          outflow,
          storage,
          updated_at: updatedAt,
          source: 'nwdp',
          resource_id: resource.resourceId,
          dataset: resource.packageName
        };
      } catch (e) {
        return null;
      }
    }));
    chunkRows.filter(Boolean).forEach((r) => rows.push(r));
  }

  nwdpAutoCache.ts = Date.now();
  nwdpAutoCache.data = rows;
  return rows;
}

async function fetchWithConfig(apiConfig) {
  const headers = { ...(apiConfig.headers || {}) };
  if (apiConfig.api_key) {
    headers[apiConfig.api_key_header || 'x-api-key'] = apiConfig.api_key;
  }
  const query = new URLSearchParams(apiConfig.query_params || {});
  const url = query.toString() ? `${apiConfig.base_url}?${query.toString()}` : apiConfig.base_url;
  const timeout = apiConfig.timeout_ms || 12000;

  const res = await fetch(url, { headers, timeout });
  if (!res.ok) return [];
  const data = await res.json();
  const list = normalizeList(data);
  if (!Array.isArray(list)) return [];
  return list.map((item) => mapRecord(item, apiConfig.field_mappings));
}

/**
 * @param {Object} appConfig - full config (apis.reservoir)
 * @returns {Promise<Array<{ name, level_pct, capacity, status }>>}
 */
async function fetchReservoirLevels(appConfig) {
  const apiConfig = appConfig?.apis?.reservoir || {};
  if (!apiConfig.enabled || !apiConfig.base_url) {
    return [];
  }

  try {
    const rows = await fetchWithConfig(apiConfig);
    return rows.filter((r) => r.name !== '—' || r.level_pct > 0).map((r) => ({ ...r, source: 'reservoir' }));
  } catch (err) {
    return [];
  }
}

async function fetchNwdpReservoirLevels(appConfig) {
  const apiConfig = appConfig?.apis?.nwdp || {};
  if (!apiConfig.enabled || !apiConfig.base_url) {
    return [];
  }

  try {
    if (apiConfig.mode === 'ckan_auto') {
      const rows = await fetchNwdpAutoLevels(appConfig);
      return rows.filter((r) => r.name !== '—');
    }
    const rows = await fetchWithConfig(apiConfig);
    return rows.filter((r) => r.name !== '—' || (r.level_pct != null && r.level_pct > 0)).map((r) => ({ ...r, source: 'nwdp' }));
  } catch (err) {
    return [];
  }
}

async function fetchCombinedWaterLevels(appConfig) {
  const [nwdpRows, reservoirRows] = await Promise.all([
    fetchNwdpReservoirLevels(appConfig),
    fetchReservoirLevels(appConfig)
  ]);

  const merged = [...nwdpRows, ...reservoirRows];
  const dedup = new Map();
  merged.forEach((row) => {
    const key = (row.name || '').trim().toLowerCase();
    if (!key) return;
    if (!dedup.has(key)) dedup.set(key, row);
  });
  return [...dedup.values()];
}

module.exports = { fetchReservoirLevels, fetchNwdpReservoirLevels, fetchCombinedWaterLevels };
