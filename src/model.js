// Internal data model shared between providers, the pipeline and the writer.
//
// channel = {
//   id: string        — XMLTV channel id (e.g. "KANAL.D.tr")
//   name: string      — display name (e.g. "KANAL D")
//   icon: string?     — logo URL
//   url: string?      — official site URL (<url> element)
// }
//
// programme = {
//   channel: string   — channel id (must match a channel.id)
//   start: string     — ISO 8601 instant ("2026-09-07T06:00:00+03:00")
//   stop: string      — ISO 8601 instant
//   title: string     — programme title (required)
//   subTitle: string? — episode/subtitle (<sub-title>)
//   desc: string?     — description (<desc>)
//   category: string? — genre (<category>)
//   icon: string?     — programme artwork (<icon>)
// }

export function createChannel({ id, name, icon, url }) {
  if (!id || typeof id !== 'string') {
    throw new Error('channel.id is required');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('channel.name is required');
  }
  return {
    id,
    name,
    icon: icon != null && icon !== '' ? String(icon) : undefined,
    url: url != null && url !== '' ? String(url) : undefined,
  };
}

export function createProgramme(input) {
  for (const key of ['channel', 'start', 'stop', 'title']) {
    if (!input[key]) {
      throw new Error(`programme.${key} is required`);
    }
  }
  return {
    channel: String(input.channel),
    start: String(input.start),
    stop: String(input.stop),
    title: String(input.title),
    subTitle: input.subTitle != null ? String(input.subTitle) : undefined,
    desc: input.desc != null ? String(input.desc) : undefined,
    category: input.category != null ? String(input.category) : undefined,
    icon: input.icon != null ? String(input.icon) : undefined,
  };
}
