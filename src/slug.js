// XMLTV channel ids follow the convention observed in epgshare01 TR files:
// the channel name uppercased, every non-alphanumeric run collapsed to a
// single dot, trailing dots trimmed, plus a ".tr" suffix
// ("KANAL D" -> "KANAL.D.tr", "TRT BELGESEL" -> "TRT.BELGESEL.tr").
// Provider adapters keep a curated map for spellings that do not survive this
// rule (case-sensitive ids like "beIN.SPORTS.1.tr", aliases like "EUROSPORT
// 2 INT" -> "EUROSPORT.2.TR.HD.tr"); this slug is only the fallback.

export function channelIdFromName(name, country = 'tr') {
  const upper = String(name == null ? '' : name).trim().toUpperCase();
  const slug = upper
    .replace(/[^A-Z0-9]+/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  const suffix = String(country == null ? 'tr' : country).trim().toLowerCase() || 'tr';
  return (slug || 'UNKNOWN') + '.' + suffix;
}
