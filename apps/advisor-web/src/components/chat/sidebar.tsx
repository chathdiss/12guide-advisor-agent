"use client";

import { useMemo, useState } from "react";
import { Check, MessageSquare, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import type { Chat } from "@/lib/chat/types";
import { BrandMark } from "./brand-mark";

type Props = {
  chats: Chat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
};

type GroupKey = "groupToday" | "groupYesterday" | "groupWeek" | "groupOlder";

const DAY = 86_400_000;
const SEARCH_FROM = 6; // a search box only helps once the list is long

function groupFor(updatedAt: number, startOfToday: number): GroupKey {
  if (updatedAt >= startOfToday) return "groupToday";
  if (updatedAt >= startOfToday - DAY) return "groupYesterday";
  if (updatedAt >= startOfToday - 7 * DAY) return "groupWeek";
  return "groupOlder";
}

export function Sidebar({ chats, activeId, onSelect, onNew, onDelete, onRename }: Props) {
  const { t } = useLanguage();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const needle = query.trim().toLowerCase();
    const visible = chats
      .filter((c) => !needle || c.title.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const order: GroupKey[] = ["groupToday", "groupYesterday", "groupWeek", "groupOlder"];
    return order
      .map((key) => ({ key, chats: visible.filter((c) => groupFor(c.updatedAt, startOfToday) === key) }))
      .filter((g) => g.chats.length > 0);
  }, [chats, query]);

  const commitRename = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  const iconButton =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <BrandMark className="size-9 rounded-xl" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold">{t.appName}</div>
          <div className="truncate text-xs text-muted-foreground">{t.brandSubtitle}</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <Button className="w-full justify-start gap-2" onClick={onNew}>
          <Plus className="size-4" /> {t.newChat}
        </Button>
      </div>

      {chats.length >= SEARCH_FROM && (
        <div className="relative px-3 pb-2">
          <Search className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchChats}
            aria-label={t.searchChats}
            className="h-8 w-full rounded-lg border bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 px-2">
        {chats.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{t.noChats}</p>}
        {chats.length > 0 && groups.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t.noMatches}</p>
        )}

        {groups.map((group) => (
          <section key={group.key} className="pb-3">
            <h2 className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t[group.key]}
            </h2>
            <ul className="space-y-0.5">
              {group.chats.map((chat) => {
                const active = chat.id === activeId;
                const editing = chat.id === editingId;
                const confirming = chat.id === confirmingId;
                return (
                  <li key={chat.id}>
                    <div
                      className={cn(
                        "group relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-accent",
                        active && "bg-accent font-medium",
                        active &&
                          "before:absolute before:top-2 before:bottom-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
                      )}
                    >
                      {editing ? (
                        <>
                          <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus-visible:border-ring"
                          />
                          <button aria-label={t.save} title={t.save} className={iconButton} onClick={commitRename}>
                            <Check className="size-4" />
                          </button>
                          <button
                            aria-label={t.cancel}
                            title={t.cancel}
                            className={iconButton}
                            onClick={() => setEditingId(null)}
                          >
                            <X className="size-4" />
                          </button>
                        </>
                      ) : confirming ? (
                        <>
                          <span className="min-w-0 flex-1 truncate text-destructive">{t.deleteConfirm}</span>
                          <button
                            aria-label={t.deleteChat}
                            title={t.deleteChat}
                            className={cn(iconButton, "text-destructive hover:text-destructive")}
                            onClick={() => {
                              onDelete(chat.id);
                              setConfirmingId(null);
                            }}
                          >
                            <Check className="size-4" />
                          </button>
                          <button
                            aria-label={t.cancel}
                            title={t.cancel}
                            className={iconButton}
                            onClick={() => setConfirmingId(null)}
                          >
                            <X className="size-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => onSelect(chat.id)}
                            aria-current={active ? "page" : undefined}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{chat.title}</span>
                          </button>
                          <div
                            className={cn(
                              "flex shrink-0 gap-0.5 transition-opacity",
                              // always reachable on touch screens, on hover or keyboard focus elsewhere
                              active
                                ? "opacity-100"
                                : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                            )}
                          >
                            <button
                              aria-label={t.renameChat}
                              title={t.renameChat}
                              className={iconButton}
                              onClick={() => {
                                setEditingId(chat.id);
                                setDraft(chat.title);
                              }}
                            >
                              <Pencil className="size-3.5" />
                            </button>
                            <button
                              aria-label={t.deleteChat}
                              title={t.deleteChat}
                              className={cn(iconButton, "hover:text-destructive")}
                              onClick={() => setConfirmingId(chat.id)}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </ScrollArea>
    </div>
  );
}
