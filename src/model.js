import { parseGuideInstant } from './time.js';

const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const OPTIONAL_PROGRAMME_FIELDS = ['subTitle', 'desc', 'category', 'icon'];

export function normalizeLanguageTag(value) {
  if (typeof value !== 'string') return undefined;
  const language = value.trim();
  return LANGUAGE_RE.test(language) ? language : undefined;
}

export function programmeIdentityKey(programme) {
  return JSON.stringify([programme.channel, programme.start, programme.stop, programme.title]);
}

export function compareCodepoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareProgrammes(a, b) {
  return (
    compareCodepoint(a.channel, b.channel) ||
    parseGuideInstant(a.start).epochMs - parseGuideInstant(b.start).epochMs ||
    compareCodepoint(a.start, b.start)
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalString(value) {
  return nonEmptyString(value) ? value : undefined;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function issueTracker(onIssue) {
  const counts = new Map();
  return {
    add(code, count = 1) {
      counts.set(code, (counts.get(code) || 0) + count);
    },
    flush() {
      for (const [code, count] of counts) onIssue(code, count);
    },
  };
}

function sanitizedChannel(channel, issues) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    issues.add('invalid-channel');
    return undefined;
  }
  if (!nonEmptyString(channel.id) || !nonEmptyString(channel.name)) {
    issues.add('invalid-channel');
    return undefined;
  }
  const entry = { id: channel.id, name: channel.name };
  const icon = optionalString(channel.icon);
  const url = optionalString(channel.url);
  if (icon != null) entry.icon = icon;
  if (url != null) entry.url = url;
  return entry;
}

function sanitizedProgramme(programme, channelIds, issues) {
  if (!programme || typeof programme !== 'object' || Array.isArray(programme)) {
    issues.add('invalid-programme');
    return undefined;
  }
  if (!nonEmptyString(programme.channel)) {
    issues.add('invalid-programme');
    return undefined;
  }
  if (!channelIds.has(programme.channel)) {
    issues.add('unknown-channel');
    return undefined;
  }
  if (!nonEmptyString(programme.title)) {
    issues.add('invalid-programme');
    return undefined;
  }
  const start = parseGuideInstant(programme.start);
  const stop = parseGuideInstant(programme.stop);
  if (!start || !stop || stop.epochMs <= start.epochMs) {
    issues.add('invalid-programme');
    return undefined;
  }
  const entry = {
    channel: programme.channel,
    start: programme.start,
    stop: programme.stop,
    title: programme.title,
  };
  for (const field of OPTIONAL_PROGRAMME_FIELDS) {
    const value = optionalString(programme[field]);
    if (value != null) entry[field] = value;
  }
  return entry;
}

export function createGuideResult(input = {}, { onIssue = () => {}, sort = true } = {}) {
  const issues = issueTracker(typeof onIssue === 'function' ? onIssue : () => {});
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (source !== input) issues.add('invalid-result');

  const rawChannels = Array.isArray(source.channels) ? source.channels : [];
  const rawProgrammes = Array.isArray(source.programmes) ? source.programmes : [];
  if (source.channels != null && !Array.isArray(source.channels)) issues.add('invalid-result');
  if (source.programmes != null && !Array.isArray(source.programmes)) issues.add('invalid-result');

  const channelsById = new Map();
  for (const channel of rawChannels) {
    const entry = sanitizedChannel(channel, issues);
    if (!entry) continue;
    const existing = channelsById.get(entry.id);
    if (!existing) {
      channelsById.set(entry.id, entry);
      continue;
    }
    if (existing.icon == null && entry.icon != null) existing.icon = entry.icon;
    if (existing.url == null && entry.url != null) existing.url = entry.url;
  }
  const channelIds = new Set(channelsById.keys());

  const programmes = [];
  const identities = new Set();
  for (const programme of rawProgrammes) {
    const entry = sanitizedProgramme(programme, channelIds, issues);
    if (!entry) continue;
    const identity = programmeIdentityKey(entry);
    if (identities.has(identity)) {
      issues.add('duplicate-programme');
      continue;
    }
    identities.add(identity);
    programmes.push({ programme: entry, index: programmes.length });
  }
  if (sort) {
    programmes.sort(
      (a, b) => compareProgrammes(a.programme, b.programme) || a.index - b.index
    );
  }

  const days = nonNegativeInteger(source.days);
  const failures = nonNegativeInteger(source.failures);
  if (source.days != null && days !== source.days) issues.add('invalid-metadata');
  if (source.failures != null && failures !== source.failures) issues.add('invalid-metadata');
  const language = normalizeLanguageTag(source.language) || 'tr';
  if (source.language != null && normalizeLanguageTag(source.language) == null) {
    issues.add('invalid-language');
  }

  issues.flush();
  return {
    channels: [...channelsById.values()],
    programmes: programmes.map(({ programme }) => programme),
    days,
    failures,
    language,
  };
}

function assertOptionalString(value, field) {
  if (value != null && !nonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function validateGuideResult({ channels, programmes, lang = 'tr' }) {
  if (!Array.isArray(channels)) throw new Error('channels must be an array');
  if (!Array.isArray(programmes)) throw new Error('programmes must be an array');
  const language = normalizeLanguageTag(lang);
  if (!language) throw new Error(`Invalid XMLTV language: ${JSON.stringify(lang)}`);

  const channelIds = new Set();
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      throw new Error('channels must not contain null or non-object entries');
    }
    if (!nonEmptyString(channel.id)) throw new Error('channel.id is required');
    if (!nonEmptyString(channel.name)) throw new Error(`channel "${channel.id}" name is required`);
    assertOptionalString(channel.icon, `channel "${channel.id}" icon`);
    assertOptionalString(channel.url, `channel "${channel.id}" url`);
    if (channelIds.has(channel.id)) throw new Error(`duplicate channel id "${channel.id}"`);
    channelIds.add(channel.id);
  }

  for (const programme of programmes) {
    if (!programme || typeof programme !== 'object' || Array.isArray(programme)) {
      throw new Error('programmes must not contain null or non-object entries');
    }
    if (!nonEmptyString(programme.channel)) throw new Error('programme.channel is required');
    if (!channelIds.has(programme.channel)) {
      throw new Error(`Programme references unknown channel "${programme.channel}"`);
    }
    if (!nonEmptyString(programme.title)) {
      throw new Error(`Programme on "${programme.channel}" title is required`);
    }
    for (const field of OPTIONAL_PROGRAMME_FIELDS) {
      assertOptionalString(programme[field], `programme ${field}`);
    }
    const start = parseGuideInstant(programme.start);
    const stop = parseGuideInstant(programme.stop);
    if (!start || !stop) throw new Error(`Invalid programme instant on "${programme.channel}"`);
    if (stop.epochMs <= start.epochMs) {
      throw new Error(
        `Programme "${programme.title}" on "${programme.channel}" has stop <= start ` +
          `(${programme.stop} <= ${programme.start})`
      );
    }
  }

  return language;
}
