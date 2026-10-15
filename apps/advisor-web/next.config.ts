import type { NextConfig } from "next";

// When API_URL is set (the deployed setup), every /api/... call from the browser is forwarded to the
// backend in apps/api, so the browser only ever talks to this site. API_URL is read at build time.
// Without it, the app falls back to its own /api/chat route, which calls n8n directly.
const apiUrl = process.env.API_URL?.trim().replace(/\/+$/, "");

const nextConfig: NextConfig = {
  experimental: {
    // Next.js gives up on a forwarded request after 30 s by default, but a Super-tier answer can take
    // longer. The backend itself waits up to 120 s for the agent.
    proxyTimeout: 600_000,
  },
  async rewrites() {
    if (!apiUrl) return [];
    return {
      // beforeFiles runs before the app's own routes, so the backend wins over src/app/api/chat
      beforeFiles: [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }],
    };
  },
};

export default nextConfig;
