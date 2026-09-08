// Minimal HTML entity decoder. Hürriyet (and many publishers) emit titles as
// ASCII-safe markup with numeric references (&#x131;, &#xDC;, &#x27; ...), so
// decoded text is what we store and emit into XMLTV.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  ccedil: 'ç',
  Ccedil: 'Ç',
  ouml: 'ö',
  Ouml: 'Ö',
  uuml: 'ü',
  Uuml: 'Ü',
  auml: 'ä',
  Auml: 'Ä',
  szlig: 'ß',
  eacute: 'é',
  Eacute: 'É',
  scaron: 'š',
  Scaron: 'Š',
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(input) {
  if (input == null) return '';
  return String(input).replace(ENTITY_RE, (raw, body) => {
    if (body.charAt(0) === '#') {
      const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // XML 1.0 forbids most C0 controls and lone surrogates; a scraped page
      // that smuggles them in would make the emitted guide malformed.  Leave
      // the entity text intact instead of decoding to an illegal character.
      if (
        !Number.isFinite(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      ) {
        return raw;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return raw;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named != null ? named : raw;
  });
}
