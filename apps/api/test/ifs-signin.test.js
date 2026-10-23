// An expired IFS session shows the sign-in page, sometimes only a moment after the first page opened. Offline: fake pages, no IFS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQuickReport } from "../src/ifs-create.js";
import { createIfsRunner } from "../src/ifs-runner.js";
import { SIGN_IN_AGAIN, asksForSignIn } from "../src/ifs-signin.js";

const HOST = "env.build.ifs.cloud";
const BASE = `https://${HOST}/landing-page/`;
const LOGIN = `https://${HOST}/auth/realms/x/protocol/openid-connect/auth?code_challenge=abc`;

const page = ({ url, passwordFields = 0 }) => ({ url: () => url, locator: () => ({ count: async () => passwordFields }) });

describe("is this the sign-in page", () => {
  it("says yes for the IFS login address, another host, and a page with a password field", async () => {
    assert.equal(await asksForSignIn(page({ url: LOGIN }), HOST), true);
    assert.equal(await asksForSignIn(page({ url: "https://login.example.com/x" }), HOST), true);
    assert.equal(await asksForSignIn(page({ url: BASE, passwordFields: 1 }), HOST), true);
  });

  it("says no for the pages of IFS itself, and for a page that cannot be asked", async () => {
    assert.equal(await asksForSignIn(page({ url: BASE }), HOST), false);
    assert.equal(await asksForSignIn(page({ url: `https://${HOST}/main/ifsapplications/web/page/QuickReport/List` }), HOST), false);
    assert.equal(await asksForSignIn({ url: () => { throw new Error("closed"); } }, HOST), false);
  });

  it("tells the consultant what to do, and that nothing was bypassed", () => {
    assert.match(SIGN_IN_AGAIN, /npm run ifs:login/);
    assert.match(SIGN_IN_AGAIN, /nothing was bypassed/);
  });
});

describe("a session that expired", () => {
  // the landing page opens, and IFS sends it to the sign-in a moment later: the address changes during the pause of the runner
  const lateRedirect = () => {
    const seen = { closed: 0, urls: [], created: 0 };
    let url = BASE;
    const pageObject = {
      goto: async (u) => seen.urls.push(u),
      waitForLoadState: async () => {},
      waitForTimeout: async () => {
        url = LOGIN;
      },
      url: () => url,
      locator: () => ({ count: async () => 0 }),
    };
    const browser = { newContext: async () => ({ newPage: async () => pageObject }), close: async () => seen.closed++ };
    return { seen, loadPlaywright: async () => ({ chromium: { launch: async () => browser } }) };
  };

  it("is found by the runner even when the sign-in comes after the page opened, and nothing is created", async () => {
    const fake = lateRedirect();
    const runner = createIfsRunner({ enabled: true, baseUrl: BASE, storageState: "s.json", fileExists: () => true, playwrightInstalled: () => true, loadPlaywright: fake.loadPlaywright, create: async () => { fake.seen.created++; return {}; } });
    const r = await runner.run({});
    assert.equal(r.outcome, "auth_required");
    assert.equal(r.created, false);
    assert.match(r.steps.find((s) => s.name === "Open IFS").detail, /npm run ifs:login/);
    assert.equal(fake.seen.created, 0, "the steps in the screens are not started");
    assert.equal(fake.seen.closed, 1);
  });

  it("is named as such, not as a page that did not open, when the Quick Reports page does not show up because of the sign-in", async () => {
    const onLogin = {
      url: () => LOGIN,
      locator: () => ({ count: async () => 0 }),
      goto: async () => {},
      getByRole: () => ({ first() { return this; }, waitFor: async () => { throw new Error("Timeout 30000ms exceeded"); } }),
    };
    const clicks = [];
    onLogin.getByText = () => ({ or: () => ({}), first: () => ({ click: async () => clicks.push("click") }) });
    const r = await createQuickReport(onLogin, { report: { title: "T" }, dataSources: [{ sql: "SELECT 1 FROM dual" }] }, { listUrl: `https://${HOST}/main/ifsapplications/web/page/QuickReport/List`, timeoutMs: 50 });
    assert.equal(r.outcome, "auth_required");
    assert.equal(r.created, false);
    assert.equal(r.steps[0].detail, SIGN_IN_AGAIN);
    assert.match(r.message, /new signed-in session/);
    assert.deepEqual(clicks, []);
  });

  it("is still a plain failure when the page does not show up and IFS did not ask for a sign-in", async () => {
    const stuck = {
      url: () => `https://${HOST}/main/ifsapplications/web/page/QuickReport/List`,
      locator: () => ({ count: async () => 0 }),
      goto: async () => {},
      getByRole: () => ({ first() { return this; }, waitFor: async () => { throw new Error("Timeout 30000ms exceeded"); } }),
    };
    const r = await createQuickReport(stuck, { report: { title: "T" }, dataSources: [{ sql: "SELECT 1 FROM dual" }] }, { listUrl: stuck.url(), timeoutMs: 50 });
    assert.equal(r.outcome, "failed");
    assert.match(r.steps[0].detail, /did not open/);
  });
});
