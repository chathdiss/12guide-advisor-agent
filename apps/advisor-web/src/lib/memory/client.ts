// Talks to the memory endpoints of the backend (apps/api, /api/memory/...): chats kept on the server,
// the choices of the customer and version dropdowns, and the feedback under an answer (thumbs up saves the
// answer for reuse, thumbs down sends what is wrong).
// Nothing here may break the chat: every call answers { ok: false } instead of throwing, and the app
// keeps working from the browser's own storage when the server has no memory.
import type { Chat } from "@/lib/chat/types";

const ID_KEY = "advisor-agent:client-id:v1";
const SCOPE_KEY = "advisor-agent:scope:v1";

let fallbackId: string | null = null;

// There are no user accounts yet. A random id, made once per browser, tells the server whose chats are whose.
// It acts like a password for those chats, so it is never shown or logged.
export function clientId(): string {
  try {
    const known = localStorage.getItem(ID_KEY);
    if (known) return known;
    const fresh = crypto.randomUUID();
    localStorage.setItem(ID_KEY, fresh);
    return fresh;
  } catch {
    fallbackId ??= crypto.randomUUID();
    return fallbackId;
  }
}

export type Scope = { customer: string; ifsVersion: string };

// The customer and IFS version last chosen: a new chat starts with them
export function loadScope(): Scope {
  try {
    const raw = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}");
    return { customer: typeof raw.customer === "string" ? raw.customer : "", ifsVersion: typeof raw.ifsVersion === "string" ? raw.ifsVersion : "" };
  } catch {
    return { customer: "", ifsVersion: "" };
  }
}

export function saveScope(scope: Scope) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(scope));
  } catch {
    // storage blocked: the choice is only kept for this visit
  }
}

type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/memory${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Client-Id": clientId(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data === null) return { ok: false, status: res.status, error: data?.error ?? `HTTP ${res.status}` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
}

export const memoryApi = {
  scopes: () => call<{ customers: string[]; versions: string[] }>("GET", "/scopes"),
  listChats: () => call<{ chats: Chat[] }>("GET", "/chats"),
  saveChat: (chat: Chat) => call<{ ok: true }>("PUT", `/chats/${encodeURIComponent(chat.id)}`, chat),
  deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/chats/${encodeURIComponent(id)}`),
  sendFeedback: (feedback: FeedbackInput) => call<FeedbackResult>("POST", "/feedback", feedback),
};

export type FeedbackInput = {
  rating: "up" | "down";
  customer: string;
  ifsVersion: string;
  language: string;
  question: string;
  answer: string;
  // what a saved answer needs to be shown again exactly as it was
  sources?: unknown[];
  tier?: string;
  tierReason?: string;
  followUps?: string[];
  // what the answer was given in: the messages before the question (a question that leans on them is saved with them),
  // and whether files were attached anywhere in the chat so far (such an answer is not saved)
  history: { role: "user" | "assistant"; content: string }[];
  hadAttachments: boolean;
  // when the answer was itself a saved one
  cacheId?: number;
  // thumbs down: what is wrong, unsupported or missing
  comment?: string;
};

// saved: the answer was kept for reuse (thumbs up); switchedOff: a saved answer for this question is no longer reused (thumbs down)
export type FeedbackResult = { ok: true; saved?: boolean; reason?: string; switchedOff?: boolean; id?: number };

// For the reviewer page: the same calls with the review key
export type Lesson = {
  id: number;
  customer: string;
  ifsVersion: string;
  question: string;
  answer: string;
  rating: "up" | "down";
  correction: string;
  status: "unverified" | "approved" | "rejected";
  reviewNote: string;
  createdAt: string;
};

export const reviewApi = {
  list: (key: string, status: Lesson["status"]) =>
    call<{ lessons: Lesson[] }>("GET", `/lessons?status=${status}`, undefined, { "X-Review-Key": key }),
  stats: (key: string) => call<CacheStats>("GET", "/stats?days=30", undefined, { "X-Review-Key": key }),
  decide: (key: string, id: number, input: { status: "approved" | "rejected"; correction?: string; note?: string }) =>
    call<{ lesson: Lesson }>("POST", `/lessons/${id}/review`, input, { "X-Review-Key": key }),
};

// What the saved answers have saved in the last days (tokens are an estimate)
export type CacheStats = {
  days: number;
  hits: number;
  misses: number;
  hitRate: number;
  estimatedTokensSaved: number;
  savedAnswers: number;
  switchedOff: number;
};
