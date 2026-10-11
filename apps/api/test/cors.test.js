import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";

const SITE = "https://12guide-assistant-test.netlify.app";

describe("calls from the website's browser (CORS)", () => {
  let n8n;
  let api;
  let base;
  before(async () => {
    n8n = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer: "ok", sources: [] }));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({ n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`, corsOrigins: [`${SITE}/`] });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  it("answers the browser's check request for the listed website, with the right permissions", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "OPTIONS",
      headers: { Origin: SITE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.match(res.headers.get("access-control-allow-headers"), /Content-Type/i);
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
    assert.equal(res.headers.get("vary"), "Origin");
  });

  it("refuses the check request of any other website, and gives it no permission", async () => {
    const res = await fetch(`${base}/api/chat`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("adds the permission to the real answer for the listed website only", async () => {
    const body = JSON.stringify({ question: "What is a PO?" });
    const own = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE }, body });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("access-control-allow-origin"), SITE);
    const other = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("gives nobody permission when no website is listed", async () => {
    const closed = createApp({ n8nChatUrl: "http://127.0.0.1:1/x" });
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${closed.address().port}/api/health`, { headers: { Origin: SITE } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    } finally {
      await new Promise((r) => closed.close(r));
    }
  });
});
