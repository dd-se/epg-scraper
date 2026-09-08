// Optional channel-id alias map.
//
// Providers sometimes emit different XMLTV ids for the same channel — e.g.
// hurriyet's curated "A.HABER.tr" vs mynet's generic-slug "AHABER.tr".  A
// JSON alias map { "aliasId": "canonicalId" } makes --compare and --merge
// treat them as one channel.  Aliases are directional: the key is replaced,
// the value is kept, and resolution is transitive so alias chains
// ({ A: B, B: C }) collapse onto one canonical id.

import { readFileSync } from 'node:fs';

// Read + validate a JSON alias map file: a flat object { alias: canonical }.
export function loadAliasMap(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`failed to read alias map "${filePath}": ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`alias map "${filePath}" is not valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`alias map "${filePath}" must be a JSON object { aliasId: canonicalId }`);
  }
  return data;
}

// Build an id -> canonical id function (identity when not in the map).
// Resolution is transitive: { A: B, B: C } collapses A and B onto C so a
// chain of aliases converges on one id.  A cycle ({ A: B, B: A }) terminates
// by returning the first id already visited — never an infinite loop.
export function createCanonicalizer(aliasMap) {
  const map = aliasMap || {};
  return (id) => {
    const visited = new Set();
    while (id in map && !visited.has(id)) {
      visited.add(id);
      id = map[id];
    }
    return id;
  };
}