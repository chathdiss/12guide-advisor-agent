// The log of what stops or surprises the backend (src/process-log.js). Offline: a fake process, nothing is exited.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { installProcessLog } from "../src/process-log.js";

const setup = () => {
  const proc = Object.assign(new EventEmitter(), { pid: 4242 });
  const lines = [];
  const exits = [];
  installProcessLog({ proc, write: (l) => lines.push(JSON.parse(l)), exit: (c) => exits.push(c), now: () => "T" });
  return { proc, lines, exits };
};

describe("the log of the process of the backend", () => {
  it("writes a line when it starts, with its pid, so that a restart can be seen", () => {
    const { lines } = setup();
    assert.deepEqual(lines, [{ time: "T", route: "process", pid: 4242, event: "started" }]);
  });

  it("logs a promise that nobody handled, with a short reason, and does not stop the backend", () => {
    const { proc, lines, exits } = setup();
    proc.emit("unhandledRejection", new Error("Target page, context or browser has been closed"));
    assert.equal(lines.at(-1).event, "unhandled_rejection");
    assert.equal(lines.at(-1).error, "Error: Target page, context or browser has been closed");
    assert.deepEqual(exits, []);
  });

  it("logs an error that nobody caught, and then stops with code 1", () => {
    const { proc, lines, exits } = setup();
    proc.emit("uncaughtException", new TypeError("x is not a function"));
    assert.equal(lines.at(-1).event, "uncaught_exception");
    assert.equal(lines.at(-1).error, "TypeError: x is not a function");
    assert.deepEqual(exits, [1]);
  });

  it("logs a signal that stops it, and its exit code", () => {
    const { proc, lines, exits } = setup();
    proc.emit("SIGTERM");
    assert.deepEqual(lines.at(-1), { time: "T", route: "process", pid: 4242, event: "signal", signal: "SIGTERM" });
    assert.deepEqual(exits, [0]);
    proc.emit("exit", 0);
    assert.equal(lines.at(-1).event, "exit");
    assert.equal(lines.at(-1).code, 0);
  });

  it("never writes more than a short reason: not a long message, not an object", () => {
    const { proc, lines } = setup();
    proc.emit("unhandledRejection", new Error("x".repeat(1000)));
    assert.ok(lines.at(-1).error.length < 200);
    proc.emit("unhandledRejection", { secret: "page content" });
    assert.ok(!JSON.stringify(lines.at(-1)).includes("page content"));
    proc.emit("unhandledRejection", undefined);
    assert.equal(lines.at(-1).error, "Error: ");
  });
});
