// csv-reader-speed-01-run-20261121 entry: a faster drop-in for csv-reader 1.0.0.
// run(input) returns exactly csv-reader 1.0.0's answer for {text, header}:
// {columns, rows, errors}. Dependency-free ES module, no network, no state
// kept between calls.
//
// Speed strategy: most records are clean physical lines — no quotes, no lone
// CRs — so each is taken whole with one slice + split(','). Records that do
// contain quotes or stray CRs go through a field-by-field reader that jumps
// with indexOf instead of stepping one character at a time. All of
// csv-reader's broken-row policy is preserved exactly (see the comments at
// each site).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, appending onto `value`.
  // Returns [value, ended, added]: `added` counts the characters kept
  // (a dropped stray CR is not counted). A CR not followed by LF is dropped
  // with a stray_cr error; CRLF is one line break.
  function readUnquoted(value) {
    let added = 0;
    let start = pos;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = text.indexOf('\r', pos);
      let idx = -1;
      let kind = END;
      if (ci !== -1 && (idx === -1 || ci < idx)) { idx = ci; kind = COMMA; }
      if (ni !== -1 && (idx === -1 || ni < idx)) { idx = ni; kind = LINE_BREAK; }
      if (ri !== -1 && (idx === -1 || ri < idx)) { idx = ri; kind = 3; }
      if (idx === -1) {
        added += n - start;
        value += text.slice(start, n);
        pos = n;
        return [value, END, added];
      }
      if (kind === COMMA) {
        added += idx - start;
        value += text.slice(start, idx);
        pos = idx + 1;
        return [value, COMMA, added];
      }
      if (kind === LINE_BREAK) {
        added += idx - start;
        value += text.slice(start, idx);
        pos = idx + 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      // A CR: CRLF ends the field as a line break, a lone CR is dropped.
      if (text.charCodeAt(idx + 1) === 10) {
        added += idx - start;
        value += text.slice(start, idx);
        pos = idx + 2;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      added += idx - start;
      value += text.slice(start, idx);
      pushError('stray_cr');
      pos = idx + 1;
      start = pos;
    }
  }

  // Normalizes one quoted span [from, to): every LF, CRLF and lone CR inside
  // it counts one line, and CRLF / lone CR read as LF in the value.
  function quotedSpan(from, to) {
    const ni = text.indexOf('\n', from);
    const ri = text.indexOf('\r', from);
    if ((ni === -1 || ni >= to) && (ri === -1 || ri >= to)) return text.slice(from, to);
    const s = text.slice(from, to);
    let extra = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 13) { extra += 1; if (s.charCodeAt(i + 1) === 10) i += 1; }
      else if (c === 10) extra += 1;
    }
    line += extra;
    return s.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos. Returns [value, ended, added].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let seg = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted, from the opening quote's line.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote inside the field.
        value += quotedSpan(seg, q);
        value += '"';
        pos = q + 2;
        seg = pos;
        continue;
      }
      value += quotedSpan(seg, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return [value, COMMA, 0]; }
    if (c === 10) { pos += 1; line += 1; return [value, LINE_BREAK, 0]; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; return [value, LINE_BREAK, 0]; }
    // What follows the closing quote is appended as it stands; quote_junk
    // only when at least one character was kept (stray CRs dropped inside
    // the junk error before it, in the order met).
    const junk = readUnquoted(value);
    if (junk[2] > 0) pushError('quote_junk');
    return junk;
  }

  function finishRecord(fields, quoted) {
    // A line left with no characters is no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a physical line with no quote and no lone CR is one whole
    // record (a record can only span lines through a quoted field, which
    // needs a quote on this line to open).
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      let end = lineEnd;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1; // CRLF
      const r = text.indexOf('\r', pos);
      if (r === -1 || r >= end) {
        const fields = text.slice(pos, end).split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        finishRecord(fields, false);
        continue;
      }
    }

    // Slow path: field by field.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
    } while (field[1] === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
