function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(dam|reservoir|barrage|project|lake|rl\d+|ph|bbmb)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  const text = normalizeText(value);
  if (!text) return [];
  return text.split(' ').filter((t) => t.length > 2);
}

function jaccardScore(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const item of A) if (B.has(item)) intersection++;
  const union = new Set([...A, ...B]).size;
  return union ? intersection / union : 0;
}

const DAM_ALIASES = {
  'tehri dam': ['tehri'],
  'bhakra nangal dam': ['bhakra', 'bhakra dam'],
  'hirakud dam': ['hirakud'],
  'sardar sarovar dam': ['sardar sarovar'],
  'nagarjuna sagar dam': ['nagarjuna sagar'],
  'srisailam dam': ['srisailam'],
  'idukki dam': ['idukki'],
  'koyna dam': ['koyna'],
  'indira sagar dam': ['indira sagar', 'narmada sagar'],
  'krishna raja sagara': ['krishna raja sagar', 'krs'],
  'mettur dam': ['mettur'],
  'maithon dam': ['maithon'],
  'panchet dam': ['panchet'],
  'ukai dam': ['ukai'],
  'pong dam': ['pong'],
  'pandoh dam': ['pandoh'],
  'chamera dam': ['chamera'],
  'gumti dam': ['gumti'],
  'ramganga dam': ['ramganga'],
  'nizam sagar': ['nizam sagar', 'nizamsagar'],
  'singur dam': ['singur'],
  'kadana dam': ['kadana'],
  'dantiwada dam': ['dantiwada'],
  'umiam lake dam': ['umiam', 'umiam lake']
};

function getCandidateNames(damName) {
  const key = String(damName || '').toLowerCase();
  const aliases = DAM_ALIASES[key] || [];
  return [damName, ...aliases].filter(Boolean);
}

function scoreReservoirMatch(dam, reservoir) {
  const damNames = getCandidateNames(dam?.name);
  const reservoirName = reservoir?.name || '';
  const damState = normalizeText(dam?.state);
  const reservoirState = normalizeText(reservoir?.state);

  let bestNameScore = 0;
  for (const name of damNames) {
    const score = jaccardScore(name, reservoirName);
    if (score > bestNameScore) bestNameScore = score;

    const normDam = normalizeText(name);
    const normRes = normalizeText(reservoirName);
    if (normDam && normRes && (normRes.includes(normDam) || normDam.includes(normRes))) {
      bestNameScore = Math.max(bestNameScore, 0.9);
    }
  }

  let stateBonus = 0;
  if (damState && reservoirState && damState === reservoirState) stateBonus = 0.2;

  return bestNameScore + stateBonus;
}

function matchReservoirToDam(dam, reservoirLevels, minScore = 0.45) {
  if (!dam || !Array.isArray(reservoirLevels) || !reservoirLevels.length) return null;

  let best = null;
  let bestScore = 0;
  for (const reservoir of reservoirLevels) {
    const score = scoreReservoirMatch(dam, reservoir);
    if (score > bestScore) {
      best = reservoir;
      bestScore = score;
    }
  }

  if (bestScore < minScore) return null;
  return { ...best, match_score: Math.round(bestScore * 100) / 100 };
}

module.exports = {
  normalizeText,
  scoreReservoirMatch,
  matchReservoirToDam
};
