// Answers that n8n delivers later. A complete answer takes a minute or more, longer than the gateway in front of a
// shared n8n server keeps a request open. So the backend sends the question with a one-time return address, n8n
// answers "accepted" at once, and when the answer is ready n8n posts it to that address (a separate, short request).
// This module is the waiting list: `expect(id)` is registered before the question is sent, `deliver(id, value)` is
// called when n8n posts the answer, and whoever waits gets it. It lives in this process, so it needs one instance.

export function createPendingAnswers() {
  const waiting = new Map();

  return {
    // Returns { wait(ms), cancel() }. `wait` resolves with the delivered value, or with null after `ms`.
    expect(id) {
      let finish;
      const arrived = new Promise((resolve) => (finish = resolve));
      waiting.set(id, finish);
      return {
        wait(ms) {
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              waiting.delete(id);
              resolve(null);
            }, ms);
            arrived.then((value) => {
              clearTimeout(timer);
              waiting.delete(id);
              resolve(value);
            });
          });
        },
        cancel() {
          waiting.delete(id);
        },
      };
    },

    // true when somebody was waiting for this id
    deliver(id, value) {
      const finish = waiting.get(id);
      if (!finish) return false;
      waiting.delete(id);
      finish(value);
      return true;
    },

    get size() {
      return waiting.size;
    },
  };
}
