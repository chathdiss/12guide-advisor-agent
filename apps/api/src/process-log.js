// What stops or surprises the backend must leave a line in its log. A run of Option A or of the test run that is lost (the page says the answer of the
// backend was lost) has to be explainable afterwards: did the backend start, exit, get a signal, or hit an error that nobody caught? Only the type and a
// short reason are written, never content (a page, a design, a value).
const describe = (reason) => `${reason?.name ?? "Error"}: ${String(reason?.message ?? reason ?? "").slice(0, 150)}`;

// proc: the process (an EventEmitter with pid and exit); write(line): where the lines go
export function installProcessLog({ proc = process, write = (line) => console.log(line), exit = (code) => proc.exit(code), now = () => new Date().toISOString() } = {}) {
  const line = (fields) => write(JSON.stringify({ time: now(), route: "process", pid: proc.pid, ...fields }));

  line({ event: "started" });
  // a promise that nobody handled (a stray error of the browser, for example): it is logged, and the backend goes on, so that one lost promise does not
  // end a run that is going on
  proc.on("unhandledRejection", (reason) => line({ event: "unhandled_rejection", error: describe(reason) }));
  // an error that nobody caught is not survivable: it is logged, and the backend stops
  proc.on("uncaughtException", (err) => {
    line({ event: "uncaught_exception", error: describe(err) });
    exit(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    proc.on(signal, () => {
      line({ event: "signal", signal });
      exit(0);
    });
  }
  proc.on("exit", (code) => line({ event: "exit", code }));
}
