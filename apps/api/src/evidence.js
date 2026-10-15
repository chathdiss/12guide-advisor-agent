// The evidence of one question: every passage the agent was given, the first ones with the question and the later ones
// through its search tools (see tools.js). The agent cites them as [n]; the backend checks those markers against this list
// when the answer is back (cite.js), so a passage found halfway through the answer can be cited as safely as the first ones.
//
// Ids are the position in the list plus one, which is what cite.js expects. The list only grows, so a number the agent
// has seen never changes meaning. It lives in this process while the question is being answered.

const KEEP_MS = 20 * 60 * 1000; // a run that never ended (n8n died) is forgotten after this long
const keyOf = (p) => `${p.path}#${p.startLine}-${p.endLine}`;

export function createEvidence({ maxPassages = 60, maxToolCalls = 6, maxExtraChars = 120_000 } = {}) {
  const runs = new Map();

  return {
    // `passages` are the ones sent with the question (ids 1..n)
    start(id, passages = []) {
      const run = { passages: [...passages], keys: new Map(passages.map((p, i) => [keyOf(p), i + 1])), calls: 0, extraChars: 0, timer: null };
      run.timer = setTimeout(() => runs.delete(id), KEEP_MS);
      run.timer.unref?.();
      runs.set(id, run);
    },

    has: (id) => runs.has(id),

    // Counts one tool call. false when the agent has used up its calls: it must then answer with what it has.
    useCall(id) {
      const run = runs.get(id);
      if (!run || run.calls >= maxToolCalls) return false;
      run.calls++;
      return true;
    },

    callsLeft: (id) => Math.max(0, maxToolCalls - (runs.get(id)?.calls ?? maxToolCalls)),

    // Adds what a tool found. Returns the passages with their ids: a passage seen before keeps its id, and a new one
    // gets the next. Nothing new is added once the list or the extra text is full (the old ones are still returned).
    add(id, found) {
      const run = runs.get(id);
      if (!run) return [];
      const out = [];
      for (const p of found) {
        const key = keyOf(p);
        const known = run.keys.get(key);
        if (known) {
          if (!out.some((o) => o.id === known)) out.push(run.passages[known - 1]);
          continue;
        }
        if (run.passages.length >= maxPassages || run.extraChars + p.content.length > maxExtraChars) continue;
        const passage = { ...p, id: run.passages.length + 1 };
        run.passages.push(passage);
        run.keys.set(key, passage.id);
        run.extraChars += p.content.length;
        out.push(passage);
      }
      return out;
    },

    passages: (id) => runs.get(id)?.passages ?? [],

    // what the agent did, for the log
    stats(id) {
      const run = runs.get(id);
      return run ? { toolCalls: run.calls, passages: run.passages.length } : { toolCalls: 0, passages: 0 };
    },

    end(id) {
      clearTimeout(runs.get(id)?.timer);
      runs.delete(id);
    },

    get size() {
      return runs.size;
    },
  };
}
