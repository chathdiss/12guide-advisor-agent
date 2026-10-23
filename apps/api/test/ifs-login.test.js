// Saving a signed-in IFS session (src/ifs-login.js, src/cli/ifs-login.js). Offline: a fake browser and a temporary folder. IFS is never opened.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { saveSession } from "../src/ifs-login.js";

const HOST = "env.build.ifs.cloud";
const BASE = `https://${HOST}/landing-page/`;
const LOGIN = `https://${HOST}/auth/realms/x/protocol/openid-connect/auth`;
const SECRET = "cookie-value-that-must-never-be-printed";

// a browser that allows only what the script is meant to do: any other property is an interaction, and throws
const strict = (name, allowed) =>
  new Proxy(allowed, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (!(prop in target)) throw new Error(`forbidden interaction: ${name}.${String(prop)}`);
      return target[prop];
    },
  });

// signedInAfter: how many Enters the consultant needs before the browser is signed in; cookies: what the session holds then
const fakeBrowser = ({ signedInAfter = 1, cookies = [{ name: "KEYCLOAK_IDENTITY", value: SECRET, domain: HOST }], closed = false, storageFails = false } = {}) => {
  const seen = { launch: null, contextOptions: "not called", goto: [], closed: 0, storageStateCalls: 0 };
  let enters = 0;
  const page = strict("page", {
    goto: async (url, options) => seen.goto.push([url, options.waitUntil]),
    url: () => (enters >= signedInAfter ? BASE : LOGIN),
    locator: () => strict("locator", { count: async () => 0 }),
    isClosed: () => closed,
  });
  const context = strict("context", {
    newPage: async () => page,
    storageState: async () => {
      seen.storageStateCalls++;
      if (storageFails) throw new Error("context closed");
      return { cookies: enters >= signedInAfter ? cookies : [], origins: [] };
    },
  });
  const browser = strict("browser", { newContext: async (...args) => ((seen.contextOptions = args), context), close: async () => void seen.closed++ });
  const playwright = { chromium: { launch: async (options) => ((seen.launch = options), browser) } };
  // the consultant's lines: each Enter is counted when it is read
  const lines = (...items) => (async function* () { for (const item of items) { if (item === "") enters++; yield item; } })();
  return { playwright, seen, lines };
};

describe("saving the session", () => {
  const dirs = [];
  const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "ifs-login-"))), dirs.at(-1));
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const run = async (fake, input, file) => {
    const out = [];
    const result = await saveSession({ playwright: fake.playwright, baseUrl: BASE, storageState: file, lines: fake.lines(...input), out: (m) => out.push(m) });
    return { ...result, out: out.join("\n") };
  };

  it("opens a clean visible browser at IFS, waits for Enter, and saves the session of that browser", async () => {
    const dir = tmp();
    const file = join(dir, "sessions", "ifs-session.json");
    const fake = fakeBrowser();
    const r = await run(fake, [""], file);
    assert.deepEqual(fake.seen.launch, { headless: false });
    assert.deepEqual(fake.seen.contextOptions, [], "a clean browser: no old session is loaded");
    assert.deepEqual(fake.seen.goto, [[BASE, "domcontentloaded"]]);
    assert.equal(r.saved, true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.cookies.length, 1);
    assert.equal(saved.cookies[0].domain, HOST);
    assert.equal(fake.seen.closed, 1, "the browser is closed");
    assert.deepEqual(readdirSync(join(dir, "sessions")), ["ifs-session.json"], "no half-written file is left");
  });

  it("never shows the content of the session", async () => {
    const file = join(tmp(), "s.json");
    const r = await run(fakeBrowser(), [""], file);
    assert.ok(!r.out.includes(SECRET));
    assert.match(r.out, /its content is not shown/);
    assert.match(r.out, /1 cookies/);
  });

  it("does not save while IFS still shows the sign-in page, and saves after the consultant has signed in and pressed Enter again", async () => {
    const file = join(tmp(), "s.json");
    const fake = fakeBrowser({ signedInAfter: 2 });
    const r = await run(fake, ["", ""], file);
    assert.match(r.out, /still shows the sign-in page/);
    assert.equal(fake.seen.storageStateCalls, 1, "the session was read once, after the sign-in");
    assert.equal(r.saved, true);
  });

  it("does not replace the old session when nothing was saved: q, or a browser without a session", async () => {
    const file = join(tmp(), "s.json");
    writeFileSync(file, '{"cookies":[{"name":"old"}],"origins":[]}');
    const quit = await run(fakeBrowser({ signedInAfter: 9 }), ["q"], file);
    assert.equal(quit.saved, false);
    assert.match(quit.out, /Nothing was saved/);
    const empty = await run(fakeBrowser({ signedInAfter: 1, cookies: [] }), ["", "q"], file);
    assert.equal(empty.saved, false);
    assert.match(empty.out, /no session yet/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).cookies[0].name, "old", "the old file is as it was");
  });

  it("says so, and saves nothing, when the window was closed or the session cannot be read", async () => {
    const file = join(tmp(), "s.json");
    const closed = await run(fakeBrowser({ closed: true }), [""], file);
    assert.match(closed.out, /window was closed/);
    const broken = await run(fakeBrowser({ storageFails: true }), [""], file);
    assert.match(broken.out, /could not be read from the browser/);
    assert.equal(existsSync(file), false);
  });

  it("answers another key with a hint and goes on waiting, and closes the browser when it stops", async () => {
    const file = join(tmp(), "s.json");
    const fake = fakeBrowser();
    const r = await run(fake, ["hello", "q"], file);
    assert.match(r.out, /Press Enter when you are signed in, or q to quit/);
    assert.equal(r.saved, false);
    assert.equal(fake.seen.closed, 1);
    const ended = fakeBrowser();
    const e = await run(ended, [], file);
    assert.equal(e.saved, false);
    assert.equal(ended.seen.closed, 1);
  });
});

describe("what this code is allowed to do", () => {
  const sources = ["../src/ifs-login.js", "../src/cli/ifs-login.js"].map((p) => [p, readFileSync(new URL(p, import.meta.url), "utf8")]);
  const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("never types, clicks, runs a script in the page, or reads what is on it: only the address, the sign-in check and the session", () => {
    for (const [name, text] of sources) {
      assert.ok(!/\.(click|dblclick|fill|type|press|check|selectOption|evaluate|evaluateHandle|innerText|textContent|inputValue|screenshot|route|addInitScript)\s*\(/.test(code(text)), name);
      assert.ok(!/\b(keyboard|mouse)\b/.test(code(text)), name);
      assert.ok(!/\bfetch\s*\(|node:https?/.test(code(text)), name);
    }
  });

  it("writes only the session file and its temporary copy, and keeps the session out of the repository", () => {
    const lib = code(sources[0][1]);
    assert.equal((lib.match(/writeFileSync\(/g) ?? []).length, 1);
    assert.ok(!/unlinkSync|rmSync|appendFileSync/.test(lib));
    assert.match(sources[1][1], /assertOutsideRepo\(storageState, repoRoot\)/);
  });
});
