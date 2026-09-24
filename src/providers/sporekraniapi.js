// Spor Ekranı API provider — same nine channels as the SSR adapter, but one
// day-scoped GET /events request per requested date. The API publishes event
// start times only; slots never chain across a response's day boundary.

import { fetchText, createPoliteFetch } from '../http.js';
import {
  defaultDates,
  deriveStartOnlyProgrammes,
  finishResult,
  splitDate,
} from './shared.js';
import { isRealCalendarDate, parseClockMinutes } from '../time.js';
import { CHANNELS, CHANNEL_ID_MAP, normalizeChannelKey } from './sporekrani.js';

export { CHANNEL_ID_MAP, normalizeChannelKey };

export const BASE_URL = 'https://api.sporekrani.com/v3/';
export const APP_ID_ENV = 'SPOREKRANI_API_APP_ID';
export const API_KEY_ENV = 'SPOREKRANI_API_KEY';

function requireCredential(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function readApiCredentials(env = process.env) {
  return {
    appId: requireCredential(env?.[APP_ID_ENV], APP_ID_ENV),
    apiKey: requireCredential(env?.[API_KEY_ENV], API_KEY_ENV),
  };
}

export function buildEventsUrl(day, credentials) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  const dateDay = match ? Number(match[3]) : NaN;
  if (!isRealCalendarDate(year, month, dateDay)) {
    throw new Error(`Invalid API day: ${JSON.stringify(day)}`);
  }
  const { appId, apiKey } = credentials || {};
  const url = new URL('events', BASE_URL);
  url.search = new URLSearchParams({
    app_id: requireCredential(appId, APP_ID_ENV),
    api_key: requireCredential(apiKey, API_KEY_ENV),
    day,
  });
  return url.toString();
}

export function parseApiEnvelope(text) {
  let payload;
  try {
    payload = JSON.parse(String(text == null ? '' : text));
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) return [];
  return payload.data;
}

function parseSourceSlot(event, expectedDay) {
  if (!event || typeof event !== 'object' || !Array.isArray(event.channels)) return undefined;
  const title = typeof event.name === 'string' ? event.name.replace(/\s+/g, ' ').trim() : '';
  const dateTime = typeof event.date_time === 'string' ? event.date_time.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(?::\d{2})?$/.exec(dateTime);
  if (!title || !match || match[1] + '-' + match[2] + '-' + match[3] !== expectedDay) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealCalendarDate(year, month, day)) return undefined;
  const startMin = parseClockMinutes(Number(match[4]), Number(match[5]));
  if (startMin == null) return undefined;
  const category =
    typeof event.sport_name === 'string' && event.sport_name.trim()
      ? event.sport_name.replace(/\s+/g, ' ').trim()
      : undefined;
  return { title, date: expectedDay, startMin, category, owners: event.channels };
}

export function parseDayEvents(events, expectedDay) {
  const slots = [];
  const channelIcons = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const parsed = parseSourceSlot(event, expectedDay);
    if (!parsed) continue;
    for (const owner of parsed.owners) {
      const id = CHANNEL_ID_MAP[normalizeChannelKey(owner?.name)];
      if (id == null) continue;
      const slot = {
        channel: id,
        date: parsed.date,
        startMin: parsed.startMin,
        title: parsed.title,
      };
      if (parsed.category != null) slot.category = parsed.category;
      slots.push(slot);
      const { icon } = owner;
      if (
        !channelIcons.has(id) &&
        typeof icon === 'string' &&
        /^https?:\/\//i.test(icon) &&
        !icon.includes('|')
      ) {
        channelIcons.set(id, icon);
      }
    }
  }
  slots.sort(
    (a, b) => a.channel.localeCompare(b.channel) || a.startMin - b.startMin || a.title.localeCompare(b.title)
  );
  return { slots, channelIcons };
}

// One API day is already scoped to a single date, so the shared start-only
// derivation can chain each channel's stops inside that day: the final start
// ends at midnight and a later day's event never defines a stop.
function programmesForDay(slots, day) {
  const { year, month, day: dateDay } = splitDate(day);
  const byChannel = new Map();
  for (const slot of slots) {
    if (!byChannel.has(slot.channel)) byChannel.set(slot.channel, []);
    byChannel.get(slot.channel).push(slot);
  }
  const programmes = [];
  for (const [channel, channelSlots] of byChannel) {
    const ordered = [...channelSlots].sort(
      (a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title)
    );
    programmes.push(...deriveStartOnlyProgrammes(ordered, { channel, year, month, day: dateDay }));
  }
  return programmes;
}

function requestErrorSummary(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status > 0) return `HTTP ${status}`;
  return 'request failed';
}

export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 300,
  maxChannels = Infinity,
  fetchOptions: inputFetchOptions = {},
  env = process.env,
} = {}) {
  const credentials = readApiCredentials(env);
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();
  const selectedChannels = CHANNELS.slice(0, maxChannels);
  const selectedIds = new Set(selectedChannels.map((channel) => channel.id));
  const politeFetch = createPoliteFetch(fetchImpl, politenessDelayMs);
  const channelIcons = new Map();
  const programmes = [];
  let failures = 0;

  for (const day of activeDates) {
    let text;
    try {
      text = await fetchText(buildEventsUrl(day, credentials), {
        fetchImpl: politeFetch,
        ...inputFetchOptions,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(inputFetchOptions.headers || {}),
        },
      });
    } catch (error) {
      failures++;
      log(`warn: ${day} request failed: ${requestErrorSummary(error)}`);
      continue;
    }

    const parsed = parseDayEvents(parseApiEnvelope(text), day);
    const daySlots = parsed.slots.filter((slot) => selectedIds.has(slot.channel));
    for (const [id, icon] of parsed.channelIcons) {
      if (selectedIds.has(id) && !channelIcons.has(id)) channelIcons.set(id, icon);
    }
    programmes.push(...programmesForDay(daySlots, day));
    log(`ok:   ${day}: ${daySlots.length} programme starts`);
  }

  return finishResult({
    channels: selectedChannels.map((channel) => {
      const icon = channelIcons.get(channel.id);
      return icon ? { id: channel.id, name: channel.name, icon } : { id: channel.id, name: channel.name };
    }),
    programmes,
    days: activeDates.length,
    failures,
    log,
  });
}
