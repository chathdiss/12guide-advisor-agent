import type { Lang } from "../i18n";
import type { Source, Tier } from "./types";

export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_TEXT_CHARS = 200_000;

// data is base64 for images and the raw file text for text files
export type AttachmentPayload = {
  name: string;
  kind: "image" | "text";
  mimeType: string;
  data: string;
};

// Contract between the web app and the n8n webhook.
export type ChatRequest = {
  chatId: string;
  question: string;
  // the language the consultant chose: the whole answer is written in it
  language?: Lang;
  // chosen in the chat: confirmed lessons apply only to this customer and IFS version
  customer?: string;
  ifsVersion?: string;
  attachments?: AttachmentPayload[];
  // true: do not return a saved answer, ask the advisor again
  fresh?: boolean;
  // previous turns, oldest first, so the agent has conversation context
  history: { role: "user" | "assistant"; content: string }[];
};

export type ChatResponse = {
  answer: string;
  sources: Source[];
  followUps?: string[];
  tier?: Tier;
  tierReason?: string;
  // approved lessons that were available for this answer
  lessons?: { id: number; correction: string }[];
  // present when a saved answer was returned without calling an AI model
  cached?: { id: number; savedAt?: string; match: "exact" | "similar" };
};
