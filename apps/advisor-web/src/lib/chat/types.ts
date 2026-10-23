export type Source = {
  title: string;
  // empty for sources without a web page, such as source code: those are cited by file and lines
  url: string;
  origin: "IFS documentation" | "IFS community" | "12Guide" | "IFS source code" | "IFS data dictionary" | "IFS API documentation" | "IFS technical blog";
  path?: string;
  startLine?: number;
  endLine?: number;
  version?: string;
  // the passage the answer is based on
  excerpt?: string;
};

// What is kept with a message in history. The file content itself is never stored.
export type AttachmentMeta = {
  id: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  size: number;
  thumbnail?: string; // small data URL, images only
};

export type Tier = "lite" | "full" | "super";

// The two workflows of the app, one tab each. They never share a chat: a chat belongs to the tab it was started in.
export type ChatKind = "advisor" | "quickReport";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  followUps?: string[];
  attachments?: AttachmentMeta[];
  tier?: Tier;
  tierReason?: string;
  lessons?: { id: number; correction: string }[];
  // set when this answer was a saved one (thumbs up by a consultant) and no AI model was called
  cached?: { id: number; savedAt?: string; match: "exact" | "similar" };
  error?: boolean;
  // the tab a message was written in. The server keeps the messages of a chat as they are, so this is how the kind of a chat survives a
  // reload from the server. Messages from before the tabs existed have none.
  mode?: ChatKind;
  createdAt: number;
};

export type Chat = {
  id: string;
  title: string;
  messages: Message[];
  // what the consultant chose for this chat; lessons are scoped to them
  customer?: string;
  ifsVersion?: string;
  kind?: ChatKind;
  createdAt: number;
  updatedAt: number;
};

// An answer that holds a quick report design: a json block with the design that the Quick Reports workflow writes (see packages/quick-reports).
// Only answers of the assistant count, and only a block that is a design: a question about quick reports, or a json block of something else,
// does not make a chat a quick report chat.
const DESIGN_BLOCK = /```json\s*(\{[\s\S]*?)```/g;
export function quickReportDesignOf(content: string): string | null {
  let found: string | null = null;
  for (const m of content.matchAll(DESIGN_BLOCK)) {
    if (!m[1].includes('"designVersion"')) continue;
    try {
      const design = JSON.parse(m[1]);
      if (design && typeof design === "object" && Array.isArray(design.dataSources) && Array.isArray(design.columns)) found = m[1].trim();
    } catch {
      // not valid JSON: not a design
    }
  }
  return found;
}

export function hasQuickReportDesign(content: string): boolean {
  return quickReportDesignOf(content) !== null;
}

// The tab a chat belongs to: what it was started as (kind, or the tag of its messages), and for a chat from before the tabs existed, whether the
// assistant ever answered it with a quick report design. Every other old chat is an Advisor Chat chat.
export function chatKind(chat: Pick<Chat, "kind" | "messages">): ChatKind {
  if (chat.kind) return chat.kind;
  const tagged = chat.messages.find((m) => m.mode)?.mode;
  if (tagged) return tagged;
  return chat.messages.some((m) => m.role === "assistant" && !m.error && hasQuickReportDesign(m.content)) ? "quickReport" : "advisor";
}
