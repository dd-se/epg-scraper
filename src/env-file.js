// Optional `.env` support for local live runs — built-ins only, because the
// constraints allow no runtime dependency for it (no dotenv).  The parsing
// itself is Node's own: `node:util`'s parseEnv() implements the same format as
// Node's `--env-file` flag, so `.env` quirks (comments, quotes, `export`
// prefixes, blank lines) behave exactly like the platform's.
//
// Node's precedence rule is kept deliberately: a variable that already exists
// in the environment is never overwritten, so a local `.env` can never shadow
// GitHub Actions secrets (or the credentials the scheduled workflow injects
// per matrix leg).  The CLI calls this before any provider reads the
// environment; `sporekraniapi` is the current credential consumer
// (SPOREKRANI_API_APP_ID / SPOREKRANI_API_KEY).

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const DEFAULT_ENV_FILE = '.env';

// Read and parse an env file.  Returns undefined when the file does not exist
// (the default `.env` is optional) and throws a readable Error when it exists
// but cannot be read.
export function readEnvFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${filePath}: ${error.message}`);
  }
  return parseEnv(text);
}

// Copy `entries` into `target` (default process.env), skipping names that are
// already set.  Returns the applied names so callers can report what happened
// without ever printing a value.
export function applyEnv(entries, { target = process.env } = {}) {
  const applied = [];
  for (const [name, value] of Object.entries(entries || {})) {
    // Never let a local file rewire prototypes: applyEnv() also accepts plain
    // objects as targets in tests.
    if (name === '__proto__') continue;
    if (target[name] !== undefined) continue;
    target[name] = value;
    applied.push(name);
  }
  return applied;
}
