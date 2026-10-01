// Channel selection for playlist entries.
//
// Patterns are **globs, never user-supplied regular expressions**: only `*`
// (any run) and `?` (one character) are honoured, compiled once and anchored.
// A user-supplied regex would be a ReDoS vector on hostile input, and an
// unanchored match would silently widen a request.
//
// Anchoring is what protects the edition invariant (SPEC §6.5.1, E1):
// `--m3u-want "ATV"` means the channel `ATV`, not every channel whose name
// contains it — so `ATV Alanya`, `ATV Avrupa` and the reversed `ALANYA ATV`
// never come along.  Editions are opted into with `ATV*` or an explicit
// `"ATV Alanya"`.

import { idKey, normalizeName, stripResolution } from './identity.js';

/**
 * Compile one glob into an anchored, case-insensitive matcher.
 *
 * Every regex metacharacter in the literal parts is escaped, so a pattern like
 * `ATV+` matches the literal text `ATV+` and cannot smuggle in a quantifier.
 *
 * Surrounding whitespace is trimmed, because patterns are matched against
 * *normalized* forms that carry no leading/trailing space.  Without this the
 * documented `"exclude": ["* Alanya *"]` would silently match nothing — the
 * form is `ATV ALANYA`, which `* Alanya *` can never reach.  Trimming keeps
 * the example working and is still strictly narrower than substring matching:
 * `ATV` remains an exact match and never selects `ATV Alanya`.
 */
export function globToMatcher(pattern) {
  const text = String(pattern == null ? '' : pattern);
  // Patterns are matched against *normalized* forms, which carry no leading,
  // trailing or doubled spaces.  A user writing `* Alanya *` means "contains
  // Alanya", but the literal spaces around the `*` would demand a real space
  // that the form does not have.  Collapsing runs of whitespace to one space
  // and trimming the edges keeps that example working — and `ATV` stays an
  // exact match, so an edition can still never be pulled in by accident.
  const source = text
    .split('*')
    // Each segment is trimmed individually: `* Alanya *` splits into
    // ['', ' Alanya ', ''], and the spaces around the wildcards would otherwise
    // demand a literal space that the normalized form `ATV ALANYA` does not
    // have. Trimming per segment (not just the whole pattern) is what makes
    // the documented `"exclude": ["* Alanya *"]` work at all.
    .map((part) =>
      part
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\?/g, '.')
    )
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * The four normalized forms a pattern is tested against — the same forms used
 * for identity, and deliberately never the raw decorated display name.
 *
 * Source A decorates 162 of its 198 names with a resolution (`ATV (360p)`), so
 * matching the raw name would silently miss 162 of them; matching the
 * paren-stripped form is what makes `ATV` select them.
 */
export function selectionForms(entry) {
  const forms = [];
  const add = (form) => {
    if (form && !forms.includes(form)) forms.push(form);
  };
  add(idKey(entry));
  add(normalizeName(entry && entry.tvgName));
  add(stripResolution(entry && entry.name));
  add(normalizeName(entry && entry.group));
  return forms;
}

/**
 * Stamp a declared `group-title` onto the entries a rule selects.
 *
 * The catalog in `channels.js` may declare the group a channel belongs to. That
 * declaration is the operator's answer to "the sources disagree, which label do
 * I actually want", so it replaces what the playlist published and outranks the
 * unify-by-count pass. Applied **after** selection, so a declared group can
 * never widen *which* entries are selected.
 *
 * The first matching rule wins, which keeps catalog order meaningful.
 *
 * @param {object[]} entries
 * @param {{pattern: string, group: string}[]} overrides
 * @returns {object[]} the entries, with `group` replaced where a rule matched
 */
export function applyGroupOverrides(entries, overrides) {
  const list = Array.isArray(entries) ? entries : [];
  const rules = (Array.isArray(overrides) ? overrides : [])
    .filter((rule) => rule && typeof rule.pattern === 'string' && rule.pattern.trim())
    .filter((rule) => typeof rule.group === 'string' && rule.group.trim())
    .map((rule) => ({ matcher: globToMatcher(rule.pattern), group: rule.group.trim() }));
  if (rules.length === 0) return list;
  return list.map((entry) => {
    const forms = selectionForms(entry);
    const hit = rules.find((rule) => forms.some((form) => rule.matcher.test(form)));
    return hit ? { ...entry, group: hit.group } : entry;
  });
}

/**
 * Pin a channel's published `tvg-id` and display name to the catalog's declared
 * values.
 *
 * Runs **after** selection and alongside `applyGroupOverrides`, and for the same
 * reason: the catalog is the operator's answer to "what is this channel called
 * and what identity does it keep", so it replaces what the sources published. A
 * declared id is permanent — it is the value a consumer stores for a viewer's
 * selection — and a declared name is pinned to the spelling the EPG guide uses.
 *
 * The first matching rule wins.  Both fields are optional, so a rule may pin
 * only the id, only the name, or both.
 *
 * @param {object[]} entries
 * @param {{pattern: string, id?: string, name?: string}[]} overrides
 * @returns {object[]}
 */
export function applyIdentityOverrides(entries, overrides) {
  const list = Array.isArray(entries) ? entries : [];
  const rules = (Array.isArray(overrides) ? overrides : [])
    .filter((rule) => rule && typeof rule.pattern === 'string' && rule.pattern.trim())
    .filter((rule) => (typeof rule.id === 'string' && rule.id.trim())
      || (typeof rule.name === 'string' && rule.name.trim()))
    .map((rule) => ({
      matcher: globToMatcher(rule.pattern),
      id: typeof rule.id === 'string' && rule.id.trim() ? rule.id.trim() : null,
      name: typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : null,
    }));
  if (rules.length === 0) return list;
  return list.map((entry) => {
    const forms = selectionForms(entry);
    const hit = rules.find((rule) => forms.some((form) => rule.matcher.test(form)));
    if (!hit) return entry;
    const next = { ...entry };
    // The writer reads `tvgId` first and falls back to `id`, so both are set to
    // keep the emitted attribute and the reported identity in agreement.
    if (hit.id) { next.tvgId = hit.id; next.id = hit.id; }
    if (hit.name) { next.name = hit.name; next.tvgName = hit.name; }
    return next;
  });
}

/**
 * Keep only the entries the operator asked for.
 *
 * `exclude` always beats `want`.  An empty `want` keeps everything.  Patterns
 * that matched nothing are returned so a typo surfaces instead of quietly
 * producing a short playlist.
 *
 * @param {object[]} entries
 * @param {object} [options]
 * @param {string[]} [options.want]    keep entries matching any of these
 * @param {string[]} [options.exclude] drop entries matching any of these
 * @returns {{ kept: object[], unmatchedPatterns: string[] }}
 */
export function selectEntries(entries, options = {}) {
  const { want = [], exclude = [] } = options;
  const list = Array.isArray(entries) ? entries : [];

  const wants = (Array.isArray(want) ? want : []).filter(Boolean).map(globToMatcher);
  const excludes = (Array.isArray(exclude) ? exclude : []).filter(Boolean).map(globToMatcher);

  // Group patterns are matched against the same four normalized forms, so a
  // single `*Undefined*` reaches source A's 41 `group-title="Undefined"`.
  const matchedWant = new Array(wants.length).fill(false);
  const kept = [];

  for (const entry of list) {
    const forms = selectionForms(entry);
    if (excludes.some((matcher) => forms.some((form) => matcher.test(form)))) continue;

    if (wants.length === 0) {
      kept.push(entry);
      continue;
    }
    let matched = false;
    for (let i = 0; i < wants.length; i += 1) {
      if (forms.some((form) => wants[i].test(form))) {
        matched = true;
        matchedWant[i] = true;
      }
    }
    if (matched) kept.push(entry);
  }

  const unmatchedPatterns = (Array.isArray(want) ? want : [])
    .filter(Boolean)
    .filter((_, i) => !matchedWant[i]);

  return { kept, unmatchedPatterns };
}