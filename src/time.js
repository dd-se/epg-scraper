const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
const GUIDE_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;
const XMLTV_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/;

const pad = (value, width = 2) => String(value).padStart(width, '0');

function utcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

function validClock(hour, minute, second = 0) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function offsetMinutes(offset) {
  if (offset == null || offset === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return undefined;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

export function isRealCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = utcDate(year, month, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function parseClockMinutes(hours, minutes, { allowEndOfDay = false } = {}) {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined;
  if (hours === 24 && minutes === 0 && allowEndOfDay) return 1440;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

export function wallToInstant(year, month, day, minutes, offset = '+03:00') {
  if (!isRealCalendarDate(year, month, day)) return undefined;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return undefined;
  const normalizedOffset = String(offset);
  if (offsetMinutes(normalizedOffset) == null) return undefined;
  const dayOffset = Math.floor(minutes / 1440);
  const minuteOfDay = minutes % 1440;
  const date = utcDate(
    year,
    month,
    day + dayOffset,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0
  );
  if (Number.isNaN(date.getTime())) return undefined;
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00${normalizedOffset}`
  );
}

function parseIso(value) {
  const match = ISO_RE.exec(String(value == null ? '' : value));
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] == null ? 0 : Number(match[6]);
  if (!isRealCalendarDate(year, month, day) || !validClock(hour, minute, second)) return undefined;
  if (offsetMinutes(match[8]) == null) return undefined;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction: match[7],
    offset: match[8],
  };
}

export function parseGuideInstant(value) {
  const match = GUIDE_ISO_RE.exec(String(value == null ? '' : value));
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = `${match[7]}${match[8]}:${match[9]}`;
  if (!isRealCalendarDate(year, month, day) || !validClock(hour, minute, second)) return undefined;
  const offsetMs = offsetMinutes(offset);
  if (offsetMs == null) return undefined;
  const date = utcDate(year, month, day, hour, minute, second).getTime();
  return {
    iso: String(value),
    epochMs: date - offsetMs * 60000,
  };
}

export function isoToEpochMs(value) {
  const parts = parseIso(value);
  if (!parts) return undefined;
  const wallMs = utcDate(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ).getTime();
  const offsetMs = offsetMinutes(parts.offset);
  if (offsetMs == null) return undefined;
  const fractionMs = parts.fraction ? Number(`0.${parts.fraction}`) * 1000 : 0;
  return wallMs - offsetMs * 60000 + fractionMs;
}

export function toXmltvTimestamp(value) {
  const source = String(value == null ? '' : value);
  const match = ISO_RE.exec(source);
  if (!match) {
    throw new Error(`Invalid ISO datetime: ${JSON.stringify(value)}`);
  }
  if (match[7]) {
    throw new Error(`Fractional seconds are not representable in XMLTV: ${JSON.stringify(value)}`);
  }
  if (offsetMinutes(match[8]) == null) {
    throw new Error(`Invalid offset in datetime: ${JSON.stringify(value)}`);
  }
  const parts = parseIso(value);
  if (!parts) {
    throw new Error(`Impossible datetime: ${JSON.stringify(value)}`);
  }
  const normalizedOffset =
    parts.offset == null || parts.offset === 'Z' ? '+0000' : parts.offset.replace(':', '');
  return (
    `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}` +
    `${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)} ${normalizedOffset}`
  );
}

export function fromXmltvTimestamp(value) {
  const match = XMLTV_RE.exec(String(value == null ? '' : value).trim());
  if (!match) {
    throw new Error(`Invalid XMLTV timestamp: ${JSON.stringify(value)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHours = Number(match[8]);
  const offsetMinutesValue = Number(match[9]);
  if (
    !isRealCalendarDate(year, month, day) ||
    !validClock(hour, minute, second) ||
    offsetHours > 23 ||
    offsetMinutesValue > 59
  ) {
    throw new Error(`Impossible XMLTV timestamp: ${JSON.stringify(value)}`);
  }
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}` +
    `${match[7]}${pad(offsetHours)}:${pad(offsetMinutesValue)}`
  );
}
