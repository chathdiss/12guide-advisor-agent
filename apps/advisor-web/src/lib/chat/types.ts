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
  createdAt: number;
};

export type Chat = {
  id: string;
  title: string;
  messages: Message[];
  // what the consultant chose for this chat; lessons are scoped to them
  customer?: string;
  ifsVersion?: string;
  createdAt: number;
  updatedAt: number;
};
