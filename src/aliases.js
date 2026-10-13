// Optional channel-id alias map.
//
// Providers sometimes emit different XMLTV ids for the same channel — e.g.
// mynet's "FBTV.tr" vs tvplus's curated "FENERBAHCETV.tr".  A
// JSON alias map { "aliasId": "canonicalId" } makes --compare and --merge
// treat them as one channel.  Aliases are directional: the key is replaced,
// the value is kept, and resolution is transitive so alias chains
// ({ A: B, B: C }) collapse onto one canonical id.

import { readFileSync } from 'node:fs';
import { channelIdMatchKey } from './slug.js';

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
//
// The lookup is **case-insensitive**.  Reaching for this flag at all means the
// guide on the other side is not ours, so its spelling of a channel — `FBTV.tr`
// vs our curated `FENERBAHCETV.tr` — is not guaranteed to share our casing, and
// a map that only fired on an exact match would silently alias nothing.  The
// canonical *value* is returned verbatim: it is the id a guide emits.
//
// The lookup must also stay an **own**-property one.  `id in map` matches
// Object.prototype keys, so a channel id like `constructor`, `toString` or
// `__proto__` resolved to the inherited *function/object* instead of its own
// name; merge then rejected the non-string id and silently dropped the channel
// and all of its programmes.  Indexing `Object.entries()` keeps the map to its
// own enumerable entries, and only a string target is ever indexed.
export function createCanonicalizer(aliasMap) {
  const map = aliasMap || {};
  const index = new Map();
  for (const [alias, canonical] of Object.entries(map)) {
    if (typeof canonical !== 'string') continue;
    const key = channelIdMatchKey(alias);
    if (!index.has(key)) index.set(key, canonical);
  }
  return (id) => {
    const visited = new Set();
    let current = id;
    while (typeof current === 'string' || typeof current === 'number') {
      const key = channelIdMatchKey(String(current));
      if (!index.has(key) || visited.has(key)) break;
      visited.add(key);
      current = index.get(key);
    }
    return current;
  };
}