// Config loading and validation for the `--m3u` mode.
//
// The config file is data, so it is validated strictly: an unknown key or a
// wrong type is a typo the operator wants to hear about immediately, not a
// silently ignored setting that produces a mysteriously short playlist.
//
// `${ENV_VAR}` placeholders in source URLs are expanded from the environment
// (the CLI has already loaded `.env` by this point).  The *value* is never
// logged — only the variable name — so a token in a playlist URL cannot leak
// into stdout or the JSON report.

import fs from 'node:fs';
import path from 'node:path';
import { catalogGroupOverrides, catalogWantPatterns, CHANNEL_CATALOG } from './channels.js';
import { NAMING_STYLES } from './identity.js';

export const DEFAULT_OUTPUT_PATH = 'playlist.m3u';

// Bounds that keep a hostile or fat-fingered config from becoming a hang.
const MAX_SOURCES = 50;
const MAX_PATTERNS = 200;

const CONFIG_KEYS = new Set([
  'sources', 'want', 'exclude', 'style', 'stripQuality', 'useYedek',
  'dedupeIdenticalUrls', 'unifyGroups', 'unifyScheme', 'keepQuery', 'inferTvgId', 'idSuffix',
  'keepAttributes', 'maxCopies', 'maxBytes', 'catalog', 'live', 'output',
]);

const SOURCE_KEYS = new Set(['id', 'name', 'url', 'weight']);
const OUTPUT_KEYS = new Set(['path', 'gzip']);
const LIVE_KEYS = new Set(['enabled', 'keepFailed', 'timeoutMs', 'concurrency', 'depth', 'retries']);

export class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message);
}

function rejectUnknownKeys(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(`${where}: unknown key "${key}" (allowed: ${[...allowed].sort().join(', ')})`);
    }
  }
}

function requireStringArray(value, where) {
  if (!Array.isArray(value)) fail(`${where} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string') fail(`${where}[${index}] must be a string, got ${typeof item}`);
    return item;
  });
}

function optionalBoolean(value, fallback, where) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`);
  return value;
}

function optionalInteger(value, fallback, where, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${where} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Expand `${VAR}` and `${VAR:-fallback}` placeholders from `env`.
 *
 * An unset variable without a fallback is an error: silently producing a URL
 * with a literal `${TOKEN}` would fail later with a confusing 404 instead of
 * naming the missing variable.
 */
export function expandEnvVars(value, env = {}, where = 'source url') {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback) => {
    const found = env[name];
    if (found != null && found !== '') return String(found);
    if (fallback !== undefined) return fallback;
    fail(`${where}: environment variable ${name} is not set`);
    return match;
  });
}

function parseSources(raw, { env }) {
  if (!Array.isArray(raw) || raw.length === 0) fail('sources must be a non-empty array');
  if (raw.length > MAX_SOURCES) fail(`sources: at most ${MAX_SOURCES} entries are allowed`);

  return raw.map((source, index) => {
    const where = `sources[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      fail(`${where} must be an object`);
    }
    rejectUnknownKeys(source, SOURCE_KEYS, where);
    if (typeof source.url !== 'string' || !source.url.trim()) {
      fail(`${where}.url must be a non-empty string`);
    }
    const id = source.id != null ? source.id : `source-${index + 1}`;
    if (typeof id !== 'string' || !id.trim()) fail(`${where}.id must be a non-empty string`);
    if (source.name != null && typeof source.name !== 'string') fail(`${where}.name must be a string`);
    if (source.weight != null && !Number.isFinite(source.weight)) {
      fail(`${where}.weight must be a number`);
    }
    return {
      id,
      name: source.name || id,
      url: expandEnvVars(source.url, env, `${where}.url`),
      weight: Number(source.weight || 0),
    };
  });
}

/**
 * Load, validate and normalize an M3U config file.
 *
 * @param {string} configPath
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env]
 * @returns {object} the resolved plan
 */
export function loadM3uConfig(configPath, options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  const resolved = path.resolve(cwd, String(configPath));

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(`config file not found: ${resolved}`);
    fail(`cannot read config file ${resolved}: ${error && error.message ? error.message : error}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    fail(`config file ${resolved} is not valid JSON: ${error && error.message ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`config file ${resolved} must contain a JSON object`);
  }
  rejectUnknownKeys(parsed, CONFIG_KEYS, 'config');

  const sources = parseSources(parsed.sources, { env });

  // `want` is data-driven: the curated catalog is the baseline and the config
  // (plus --m3u-want) appends to it.  Set `"catalog": false` to start from an
  // empty list and select purely by config.
  const useCatalog = optionalBoolean(parsed.catalog, true, 'catalog');
  const configWant = parsed.want === undefined ? [] : requireStringArray(parsed.want, 'want');
  const exclude = parsed.exclude === undefined ? [] : requireStringArray(parsed.exclude, 'exclude');
  const want = [...(useCatalog ? catalogWantPatterns(CHANNEL_CATALOG) : []), ...configWant];
  // The catalog's declared groups travel with it: turning the catalog off drops
  // both the curated selection and the group declarations.
  const groupOverrides = useCatalog ? catalogGroupOverrides(CHANNEL_CATALOG) : [];
  if (want.length > MAX_PATTERNS) fail(`want: at most ${MAX_PATTERNS} patterns are allowed`);
  if (exclude.length > MAX_PATTERNS) fail(`exclude: at most ${MAX_PATTERNS} patterns are allowed`);

  const style = parsed.style === undefined ? 'backup' : parsed.style;
  if (!NAMING_STYLES.includes(style)) {
    fail(`style must be one of ${NAMING_STYLES.join(', ')}, got ${JSON.stringify(style)}`);
  }

  const stripQuality =
    parsed.stripQuality === undefined
      ? ['HD', 'FHD', 'UHD', 'SD']
      : requireStringArray(parsed.stripQuality, 'stripQuality');

  const output = parsed.output === undefined ? {} : parsed.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) fail('output must be an object');
  rejectUnknownKeys(output, OUTPUT_KEYS, 'output');
  if (output.path != null && typeof output.path !== 'string') fail('output.path must be a string');

  const live = parsed.live === undefined ? {} : parsed.live;
  if (!live || typeof live !== 'object' || Array.isArray(live)) fail('live must be an object');
  rejectUnknownKeys(live, LIVE_KEYS, 'live');

  const idSuffix = parsed.idSuffix === undefined ? 'tr' : parsed.idSuffix;
  if (typeof idSuffix !== 'string' || !idSuffix.trim()) fail('idSuffix must be a non-empty string');

  return {
    sources,
    want,
    exclude,
    groupOverrides,
    style,
    stripQuality,
    useYedek: optionalBoolean(parsed.useYedek, true, 'useYedek'),
    dedupeIdenticalUrls: optionalBoolean(parsed.dedupeIdenticalUrls, true, 'dedupeIdenticalUrls'),
    unifyGroups: optionalBoolean(parsed.unifyGroups, true, 'unifyGroups'),
    unifyScheme: optionalBoolean(parsed.unifyScheme, true, 'unifyScheme'),
    keepQuery: optionalBoolean(parsed.keepQuery, false, 'keepQuery'),
    inferTvgId: optionalBoolean(parsed.inferTvgId, true, 'inferTvgId'),
    idSuffix: idSuffix.trim().toLowerCase(),
    keepAttributes: parsed.keepAttributes === undefined
      ? ['tvg-id', 'tvg-name', 'tvg-logo', 'group-title']
      : requireStringArray(parsed.keepAttributes, 'keepAttributes'),
    maxCopies: optionalInteger(parsed.maxCopies, 6, 'maxCopies', { min: 0, max: 1000 }),
    maxBytes: optionalInteger(
      parsed.maxBytes, 16 * 1024 * 1024, 'maxBytes',
      { min: 1024, max: 256 * 1024 * 1024 }
    ),
    live: {
      enabled: optionalBoolean(live.enabled, false, 'live.enabled'),
      keepFailed: optionalBoolean(live.keepFailed, false, 'live.keepFailed'),
      // Depth 1 (the manifest only) is the default: the requester asked for a
      // fast check, and following the first segment roughly doubles the cost
      // for a marginal gain.
      depth: optionalInteger(live.depth, 1, 'live.depth', { min: 1, max: 2 }),
      timeoutMs: optionalInteger(live.timeoutMs, 6000, 'live.timeoutMs', { min: 100, max: 120000 }),
      concurrency: optionalInteger(live.concurrency, 4, 'live.concurrency', { min: 1, max: 8 }),
      retries: optionalInteger(live.retries, 1, 'live.retries', { min: 0, max: 5 }),
    },
    output: {
      path: output.path || DEFAULT_OUTPUT_PATH,
      gzip: optionalBoolean(output.gzip, false, 'output.gzip'),
    },
  };
}