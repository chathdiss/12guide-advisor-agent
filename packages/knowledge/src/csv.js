// A small CSV reader (RFC 4180): cells in double quotes may hold commas, line breaks and "" for a quote. It reads a line end of
// \r\n or \n, ignores a byte order mark at the start (PowerShell writes one), and finds out whether the file uses a comma or a
// semicolon from its first line. Empty lines are skipped.
// csvRows gives the rows one at a time (for files that are too big to hold as rows); parseCsv gives all of them as an array.

export function* csvRows(input) {
  const text = String(input ?? "");
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  // the separator is the one that is used more often in the first line (outside quotes it is the only place that matters here)
  const first = src.slice(0, Math.max(0, src.indexOf("\n")) || src.length);
  const delimiter = (first.match(/;/g) ?? []).length > (first.match(/,/g) ?? []).length ? ";" : ",";

  let row = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  // returns the finished row, or null for an empty line
  const endRow = () => {
    endCell();
    const done = row.length === 1 && row[0] === "" ? null : row;
    row = [];
    return done;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      const done = endRow();
      if (done) yield done;
    } else if (ch === "\n") {
      const done = endRow();
      if (done) yield done;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    const done = endRow();
    if (done) yield done;
  }
}

export function parseCsv(input) {
  return [...csvRows(input)];
}

// rows with a header -> objects whose keys are the header names (lower case, trimmed)
export function csvObjects(input) {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
