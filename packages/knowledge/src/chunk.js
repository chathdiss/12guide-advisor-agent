// Splits text into chunks of about TARGET characters. It cuts at natural boundaries
// (a blank line, the start of a declaration) so that a procedure is not torn in the
// middle when that can be avoided, and repeats a few lines at the start of the next
// chunk so that context is not lost at the cut.

const TARGET = 1600;
const MAX = 2400;
const OVERLAP_LINES = 3;

const BOUNDARY =
  /^\s*(--\s*-{5,}|PROCEDURE\b|FUNCTION\b|PACKAGE\b|CURSOR\b|CREATE\b|TYPE\b|public\b|private\b|protected\b|internal\b|class\b|namespace\b|\/\*\*)/i;

// Returns [{ startLine, endLine, text }] with 1-based, inclusive line numbers.
export function chunkText(text, { target = TARGET, max = MAX, overlapLines = OVERLAP_LINES } = {}) {
  const lines = text.split(/\r\n|\n|\r/);
  const chunks = [];

  let start = 0;
  let size = 0;
  let flushedUpTo = -1; // last line that is already part of an emitted chunk

  const emit = (from, to) => {
    const body = lines.slice(from, to + 1).join("\n");
    if (body.trim() !== "") chunks.push({ startLine: from + 1, endLine: to + 1, text: body });
    flushedUpTo = to;
  };

  for (let i = 0; i < lines.length; i++) {
    size += lines[i].length + 1;
    const next = lines[i + 1];
    const atBoundary = next === undefined || next.trim() === "" || BOUNDARY.test(next);

    if (size >= max || (size >= target && atBoundary)) {
      emit(start, i);
      // the next chunk starts a few lines back, but always moves forward
      start = Math.max(start + 1, i + 1 - overlapLines);
      if (start > i) start = i + 1;
      size = 0;
      for (let j = start; j <= i; j++) size += lines[j].length + 1;
    }
  }

  if (flushedUpTo < lines.length - 1) emit(start, lines.length - 1);
  return chunks;
}
