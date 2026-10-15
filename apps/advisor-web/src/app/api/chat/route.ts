import { NextResponse } from "next/server";
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TEXT_CHARS,
  type AttachmentPayload,
  type ChatRequest,
  type ChatResponse,
} from "@/lib/chat/api-types";

export const runtime = "nodejs";

const TIMEOUT_MS = 600_000;

function validAttachments(input: unknown): AttachmentPayload[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) return null;
  const out: AttachmentPayload[] = [];
  for (const a of input) {
    if (!a || typeof a.name !== "string" || typeof a.data !== "string" || typeof a.mimeType !== "string") return null;
    if (a.kind === "image") {
      if (!a.mimeType.startsWith("image/") || a.data.length > MAX_IMAGE_BASE64_CHARS) return null;
    } else if (a.kind === "text") {
      if (a.data.length > MAX_TEXT_CHARS) return null;
    } else {
      return null;
    }
    out.push({ name: a.name.slice(0, 200), kind: a.kind, mimeType: a.mimeType, data: a.data });
  }
  return out;
}

export async function POST(req: Request) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ error: "N8N_WEBHOOK_URL is not configured on the server.", code: "not_configured" }, { status: 500 });
  }

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "invalid_request" }, { status: 400 });
  }

  if (typeof body.question !== "string" || !body.question.trim()) {
    return NextResponse.json({ error: "A question is required.", code: "invalid_request" }, { status: 400 });
  }

  const attachments = validAttachments(body.attachments);
  if (!attachments) {
    return NextResponse.json(
      {
        error: `Invalid attachments. Up to ${MAX_ATTACHMENTS} images or text files, within the size limits.`,
        code: "attachments_invalid",
      },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.N8N_WEBHOOK_SECRET) headers["X-Internal-Key"] = process.env.N8N_WEBHOOK_SECRET;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatId: body.chatId,
        question: body.question,
        language: body.language === "nl" ? "nl" : "en",
        attachments,
        history: Array.isArray(body.history) ? body.history : [],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const hint =
        res.status === 404
          ? "n8n webhook not found. Is the workflow active and does the URL match?"
          : `n8n returned ${res.status}.`;
      return NextResponse.json({ error: hint, code: res.status === 404 ? "not_found" : "n8n_status" }, { status: 502 });
    }

    // n8n answers 200 with an empty body when a node in the workflow fails
    const raw = await res.text();
    let data: Partial<ChatResponse> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      // handled below
    }
    if (typeof data.answer !== "string") {
      return NextResponse.json(
        {
          error: "The n8n workflow did not return an answer. Check the Executions tab in n8n for the failing node.",
          code: "no_answer",
        },
        { status: 502 },
      );
    }

    const tier = data.tier === "lite" || data.tier === "full" || data.tier === "super" ? data.tier : undefined;
    const out: ChatResponse = {
      answer: data.answer,
      sources: Array.isArray(data.sources) ? data.sources : [],
      tier,
      tierReason: typeof data.tierReason === "string" ? data.tierReason : undefined,
      followUps: Array.isArray(data.followUps)
        ? data.followUps
            .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
            .map((q) => q.trim().slice(0, 160))
            .slice(0, 3)
        : undefined,
    };
    return NextResponse.json(out);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut ? "The advisor took too long to respond." : "Could not reach n8n. Is it running?",
        code: timedOut ? "too_slow" : "unreachable",
      },
      { status: 504 },
    );
  }
}
