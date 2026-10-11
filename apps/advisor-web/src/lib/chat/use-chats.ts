"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STRINGS, type ApiErrorCode, type Lang } from "../i18n";
import type { ChatRequest, ChatResponse } from "./api-types";
import { toMeta, type PendingAttachment } from "./attachments";
import { loadScope, memoryApi, saveScope, type Scope } from "@/lib/memory/client";
import type { Chat, Message } from "./types";

const STORAGE_KEY = "advisor-agent:chats:v1";

// A complete answer takes a minute or more, longer than a website host such as Netlify keeps a forwarded request open.
// When NEXT_PUBLIC_CHAT_API_URL is set (read when the site is built), the chat goes straight to the backend; the
// backend must list this website in CORS_ORIGINS. Without it the chat uses this site's own /api/chat.
const CHAT_API_BASE = (process.env.NEXT_PUBLIC_CHAT_API_URL ?? "").trim().replace(/\/+$/, "");

const uid = () => crypto.randomUUID();

function load(): Chat[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Chat[]) : [];
  } catch {
    return [];
  }
}

function save(chats: Chat[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch {
    // storage full or blocked: keep working in memory
  }
}

export function useChats(lang: Lang) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  // the customer and IFS version last chosen: a new chat starts with them
  const [defaultScope, setDefaultScope] = useState<Scope>({ customer: "", ifsVersion: "" });
  // updatedAt of every chat as the server last had it; a chat that differs still has to be sent
  const synced = useRef(new Map<string, number>());
  const serverUp = useRef(true);

  useEffect(() => {
    // localStorage only exists in the browser, so load after mount
    const local = load();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChats(local);
    setDefaultScope(loadScope());
    setReady(true);

    // The chats kept on the server (see the memory endpoints of the backend): the newest copy of each chat wins.
    // Without a server memory the app simply keeps working from this browser.
    let cancelled = false;
    memoryApi.listChats().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        serverUp.current = false;
        return;
      }
      for (const c of res.data.chats) synced.current.set(c.id, c.updatedAt);
      setChats((current) => {
        const byId = new Map(current.map((c) => [c.id, c]));
        for (const remote of res.data.chats) {
          const mine = byId.get(remote.id);
          if (!mine || remote.updatedAt > mine.updatedAt) byId.set(remote.id, remote);
        }
        return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready) save(chats);
  }, [chats, ready]);

  // Send new and changed chats to the server a moment after the last change
  useEffect(() => {
    if (!ready || !serverUp.current || pending) return;
    const timer = setTimeout(() => {
      for (const chat of chats) {
        if (synced.current.get(chat.id) === chat.updatedAt) continue;
        memoryApi.saveChat(chat).then((res) => {
          if (res.ok) synced.current.set(chat.id, chat.updatedAt);
        });
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [chats, ready, pending]);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  // what applies now: the open chat's choice, or the last choice for a chat that is not started yet
  const customer = activeChat ? (activeChat.customer ?? "") : defaultScope.customer;
  const ifsVersion = activeChat ? (activeChat.ifsVersion ?? "") : defaultScope.ifsVersion;
  const scope = useMemo<Scope>(() => ({ customer, ifsVersion }), [customer, ifsVersion]);

  const changeScope = useCallback(
    (change: Partial<Scope>) => {
      const next = { ...scope, ...change };
      setDefaultScope(next);
      saveScope(next);
      if (activeId) setChats((prev) => prev.map((c) => (c.id === activeId ? { ...c, ...next, updatedAt: Date.now() } : c)));
    },
    [scope, activeId],
  );

  const newChat = useCallback(() => setActiveId(null), []);

  const deleteChat = useCallback((id: string) => {
    setChats((prev) => prev.filter((c) => c.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
    synced.current.delete(id);
    if (serverUp.current) memoryApi.deleteChat(id);
  }, []);

  const renameChat = useCallback((id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean } : c)));
  }, []);

  // Sends one question to the advisor and appends the answer (or an error) to the chat.
  const ask = useCallback(
    async (
      target: string,
      question: string,
      attachments: PendingAttachment[],
      history: { role: "user" | "assistant"; content: string }[],
      chosen: Scope,
      fresh = false,
    ) => {
      const t = STRINGS[lang];
      setPending(true);

      let reply: Message;
      try {
        const res = await fetch(`${CHAT_API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: target,
            question,
            language: lang,
            customer: chosen.customer || undefined,
            ifsVersion: chosen.ifsVersion || undefined,
            history,
            fresh: fresh || undefined,
            attachments: attachments.map(({ name, kind, mimeType, data }) => ({ name, kind, mimeType, data })),
          } satisfies ChatRequest),
        });
        // A forward that fails (backend not running) comes back as plain text, not JSON
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(t.apiError("server_unreachable", undefined));
        if (!res.ok) throw new Error(t.apiError(data.code as ApiErrorCode | undefined, data.error));
        const { answer, sources, followUps, tier, tierReason, lessons, cached } = data as ChatResponse;
        reply = {
          id: uid(),
          role: "assistant",
          content: answer,
          sources,
          followUps,
          tier,
          tierReason,
          lessons: lessons && lessons.length > 0 ? lessons : undefined,
          cached,
          createdAt: Date.now(),
        };
      } catch (err) {
        // fetch itself rejects with a TypeError when the network or the site is down
        const msg =
          err instanceof TypeError
            ? t.apiError("server_unreachable", undefined)
            : err instanceof Error
              ? err.message
              : t.genericError;
        reply = { id: uid(), role: "assistant", content: msg, error: true, createdAt: Date.now() };
      }

      setChats((prev) =>
        prev.map((c) =>
          c.id === target ? { ...c, messages: [...c.messages, reply], updatedAt: Date.now() } : c,
        ),
      );
      setPending(false);
    },
    [lang],
  );

  const sendMessage = useCallback(
    async (text: string, attachments: PendingAttachment[] = []) => {
      const t = STRINGS[lang];
      const question = text.trim() || (attachments.length > 0 ? t.lookAtAttachments : "");
      if (!question || pending) return;

      const now = Date.now();
      const userMsg: Message = {
        id: uid(),
        role: "user",
        content: question,
        attachments: attachments.length > 0 ? attachments.map(toMeta) : undefined,
        createdAt: now,
      };
      let chatId = activeId;

      if (!chatId) {
        chatId = uid();
        const title = question.length > 40 ? `${question.slice(0, 40)}…` : question;
        setChats((prev) => [
          { id: chatId!, title, messages: [userMsg], createdAt: now, updatedAt: now, ...scope },
          ...prev,
        ]);
        setActiveId(chatId);
      } else {
        setChats((prev) =>
          prev.map((c) =>
            c.id === chatId ? { ...c, messages: [...c.messages, userMsg], updatedAt: now } : c,
          ),
        );
      }

      // earlier turns only: failed attempts are not part of the conversation
      const history = (chats.find((c) => c.id === chatId)?.messages ?? [])
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }));

      await ask(chatId, question, attachments, history, scope);
    },
    [activeId, pending, chats, lang, ask, scope],
  );

  // Can the last answer be requested again? Not when files were attached: their content is not kept.
  const canRetry = (() => {
    const msgs = activeChat?.messages ?? [];
    const last = msgs[msgs.length - 1];
    const asked = msgs[msgs.length - 2];
    return !pending && !!last?.error && asked?.role === "user" && !asked.attachments?.length;
  })();

  const retryLast = useCallback(async () => {
    if (!canRetry || !activeChat) return;
    const msgs = activeChat.messages;
    const asked = msgs[msgs.length - 2];
    setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, messages: c.messages.slice(0, -1) } : c)));
    const history = msgs
      .slice(0, -2)
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    await ask(activeChat.id, asked.content, [], history, scope);
  }, [canRetry, activeChat, ask, scope]);

  // A saved answer can be replaced by a new one (it is the first answer of the chat, and the last message)
  const canRefresh = (() => {
    const msgs = activeChat?.messages ?? [];
    return !pending && msgs.length === 2 && !!msgs[1].cached && msgs[0].role === "user" && !msgs[0].attachments?.length;
  })();

  const refreshAnswer = useCallback(async () => {
    if (!canRefresh || !activeChat) return;
    const asked = activeChat.messages[0];
    setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, messages: c.messages.slice(0, -1) } : c)));
    await ask(activeChat.id, asked.content, [], [], scope, true);
  }, [canRefresh, activeChat, ask, scope]);

  return {
    canRefresh,
    refreshAnswer,
    chats,
    activeChat,
    activeId,
    setActiveId,
    ready,
    pending,
    newChat,
    deleteChat,
    renameChat,
    sendMessage,
    canRetry,
    retryLast,
    scope,
    changeScope,
  };
}
