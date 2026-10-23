// A complete answer takes a minute or more, longer than a website host such as Netlify keeps a forwarded request open.
// When NEXT_PUBLIC_CHAT_API_URL is set (read when the site is built), the app talks straight to the backend; the
// backend must list this website in CORS_ORIGINS. Without it the app uses this site's own /api/... routes.
export const API_BASE = (process.env.NEXT_PUBLIC_CHAT_API_URL ?? "").trim().replace(/\/+$/, "");
