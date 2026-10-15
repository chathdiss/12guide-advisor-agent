// A small in-memory limiter: at most `limit` requests per client per minute.
// It protects the Claude budget from loops and misuse. It resets when the server restarts,
// which is fine for the test version (a shared store would be needed with several servers).

export function createRateLimiter({ limit, windowMs = 60_000 }) {
  const hits = new Map(); // client -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [client, entry] of hits) if (entry.resetAt <= now) hits.delete(client);
  }, windowMs);
  timer.unref(); // never keep the process alive just for cleanup

  return {
    // true when the request may go on, false when the client is over the limit
    allow(client, now = Date.now()) {
      const entry = hits.get(client);
      if (!entry || entry.resetAt <= now) {
        hits.set(client, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= limit;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
