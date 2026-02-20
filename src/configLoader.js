const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

let cached = null;

function loadConfig(configPath) {
  if (cached) return cached;
  const full = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  const content = fs.readFileSync(full, 'utf8');
  cached = yaml.parse(content);
  return cached;
}

module.exports = { loadConfig };
