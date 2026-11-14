/**
 * A small XML reader and the escaping the MVR writer needs.
 *
 * Hand-written rather than `DOMParser` because `domain/` has to run under
 * Node in the test suite, where there is no DOM, and because MVR and GDTF are
 * plain element-and-attribute XML: no DTDs, no namespaces that matter, no
 * mixed content worth keeping. What real files do contain — and what this
 * handles — is a BOM, comments (the MVR spec's own examples use `<!-->...</!-->`,
 * which is not a well-formed comment at all, and files copied from them do
 * too), CDATA, character references, and both
 * quote styles on attributes.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside this element, trimmed. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolve the five predefined entities and numeric character references. */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Escape text for an attribute value or element content. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NAME_CHAR = /[^\s/>=]/;

/**
 * Parse a document and return its root element.
 *
 * Tolerant where real files are sloppy (an unknown entity is left as written,
 * text outside the root is ignored) and strict where a mistake would silently
 * reshape the tree (a mismatched closing tag is an error, not a guess).
 */
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const n = text.length;

  const appendText = (raw: string): void => {
    const top = stack[stack.length - 1];
    if (!top) return;
    top.text += raw;
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      appendText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(text.slice(i, lt)));

    // Comments, including the `<!-->...</!-->` pseudo-comments the MVR spec prints.
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      // `<!-->` closes itself: the `-->` overlaps the opener.
      if (text.startsWith('<!-->', lt)) {
        i = lt + 5;
        continue;
      }
      if (end < 0) throw new XmlParseError('Unterminated comment.');
      i = end + 3;
      continue;
    }
    if (text.startsWith('</!-->', lt)) {
      i = lt + 6;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlParseError('Unterminated CDATA section.');
      appendText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlParseError('Unterminated processing instruction.');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE and friends. MVR never uses one; skip to the matching '>'.
      const end = text.indexOf('>', lt + 2);
      if (end < 0) throw new XmlParseError('Unterminated declaration.');
      i = end + 1;
      continue;
    }

    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) throw new XmlParseError('Unterminated closing tag.');
      const name = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new XmlParseError(
          `Closing tag </${name}> does not match <${top?.name ?? '(nothing)'}>.`,
        );
      }
      top.text = top.text.trim();
      i = end + 1;
      continue;
    }

    // An opening or self-closing tag.
    let j = lt + 1;
    while (j < n && NAME_CHAR.test(text[j] as string)) j++;
    const element: XmlElement = { name: text.slice(lt + 1, j), attrs: {}, children: [], text: '' };
    if (!element.name) throw new XmlParseError(`Malformed tag at offset ${lt}.`);

    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(text[j] as string)) j++;
      if (j >= n) throw new XmlParseError(`Unterminated tag <${element.name}>.`);
      const ch = text[j];
      if (ch === '>') {
        j++;
        break;
      }
      if (ch === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < n && NAME_CHAR.test(text[j] as string)) j++;
      const attrName = text.slice(nameStart, j);
      if (!attrName) throw new XmlParseError(`Malformed attribute in <${element.name}>.`);
      while (j < n && /\s/.test(text[j] as string)) j++;
      if (text[j] !== '=') {
        // A bare attribute is not XML, but costs nothing to tolerate.
        element.attrs[attrName] = '';
        continue;
      }
      j++;
      while (j < n && /\s/.test(text[j] as string)) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(`Unquoted attribute ${attrName} in <${element.name}>.`);
      }
      const close = text.indexOf(quote, j + 1);
      if (close < 0) throw new XmlParseError(`Unterminated attribute ${attrName}.`);
      element.attrs[attrName] = decodeEntities(text.slice(j + 1, close));
      j = close + 1;
    }

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (!root) root = element;

    if (!selfClosing) stack.push(element);
    i = j;
  }

  if (stack.length > 0) {
    throw new XmlParseError(`Unclosed element <${stack[stack.length - 1]?.name}>.`);
  }
  if (!root) throw new XmlParseError('No root element.');
  return root;
}

/** First direct child with this name. */
export const child = (el: XmlElement, name: string): XmlElement | undefined =>
  el.children.find((c) => c.name === name);

/** Every direct child with this name. */
export const childrenNamed = (el: XmlElement, name: string): XmlElement[] =>
  el.children.filter((c) => c.name === name);

/** Text of the first direct child with this name, or `''`. */
export const childText = (el: XmlElement, name: string): string => child(el, name)?.text ?? '';

/** Depth-first walk of every descendant with this name. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
