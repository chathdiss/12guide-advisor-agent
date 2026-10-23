"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileText, Menu, MessageSquare, PanelLeft, Paperclip, Rocket, Settings2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useLanguage } from "@/components/language-provider";
import { useChats } from "@/lib/chat/use-chats";
import { quickReportDesignOf, type ChatKind, type Message } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand-mark";
import { Composer } from "./composer";
import { QuickReportNextSteps } from "./quick-report-next-steps";
import { LanguageToggle } from "./language-toggle";
import { MessageItem } from "./message-item";
import { ScopeBar } from "./scope-bar";
import { Sidebar } from "./sidebar";
import { ThemeMenu } from "./theme-menu";
import { ThinkingIndicator } from "./thinking-indicator";

// one icon per example question: configuration, concepts, releases
const EXAMPLE_ICONS = [Settings2, BookOpen, Rocket];
// and for the Quick Reports tab: a description, a specification, parameters
const QUICK_REPORT_ICONS = [FileText, Paperclip, SlidersHorizontal];

const TABS: ChatKind[] = ["advisor", "quickReport"];
const TAB_STORAGE_KEY = "advisor-agent:tab";

// What an answer was given in: the messages before its question (as the chat request sent them), and whether files were
// attached anywhere in the chat so far. A thumbs up uses it to save the answer so that it is reused only when it fits.
function chatContext(messages: Message[], answerIndex: number) {
  let question = answerIndex - 1;
  while (question > 0 && messages[question].role !== "user") question--;
  const history = messages
    .slice(0, Math.max(question, 0))
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
  const hadAttachments = messages.slice(0, answerIndex).some((m) => (m.attachments?.length ?? 0) > 0);
  return { history, hadAttachments };
}

export function ChatApp() {
  const { lang, t } = useLanguage();
  // Advisor Chat and Quick Reports: every tab has its own chats, and a question goes to the workflow of its tab only
  const [tab, setTab] = useState<ChatKind>("advisor");
  const quickReports = tab === "quickReport";
  const {
    chats,
    activeChat,
    activeId,
    setActiveId,
    pending,
    newChat,
    deleteChat,
    renameChat,
    sendMessage,
    canRetry,
    retryLast,
    scope,
    changeScope,
    canRefresh,
    refreshAnswer,
  } = useChats(lang, tab);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => activeChat?.messages ?? [], [activeChat]);

  // Quick Reports only: when the latest answer holds a design, the next steps (approve, then Option A or B) are offered under it
  const lastMessage = messages[messages.length - 1];
  const nextStepsDesign = quickReports && !pending && lastMessage?.role === "assistant" && !lastMessage.error ? quickReportDesignOf(lastMessage.content) : null;

  useEffect(() => {
    // the tab that was open last time (the browser is the only place that is known, so read it after mount)
    try {
      if (localStorage.getItem(TAB_STORAGE_KEY) === "quickReport") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTab("quickReport");
      }
    } catch {
      // storage blocked: start on Advisor Chat
    }
  }, []);

  const selectTab = (next: ChatKind) => {
    setTab(next);
    setMobileOpen(false);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // not remembered
    }
  };

  const tabLabel = (kind: ChatKind) => (kind === "quickReport" ? t.tabQuickReports : t.tabAdvisor);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  const sidebar = (
    <Sidebar
      chats={chats}
      activeId={activeId}
      newLabel={quickReports ? t.newQuickReport : undefined}
      onNew={() => {
        newChat();
        setMobileOpen(false);
      }}
      onSelect={(id) => {
        setActiveId(id);
        setMobileOpen(false);
      }}
      onDelete={deleteChat}
      onRename={renameChat}
    />
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <aside
        className={cn(
          "hidden shrink-0 overflow-hidden transition-[width] duration-200 motion-reduce:transition-none md:block",
          sidebarOpen ? "w-72 border-r" : "w-0",
        )}
        aria-hidden={!sidebarOpen}
      >
        <div className="h-full w-72">{sidebar}</div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">{t.chats}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={t.openChats}
          >
            <Menu className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden text-muted-foreground md:inline-flex"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label={sidebarOpen ? t.collapseSidebar : t.expandSidebar}
            title={sidebarOpen ? t.collapseSidebar : t.expandSidebar}
          >
            <PanelLeft className="size-4.5" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{activeChat?.title ?? (quickReports ? t.tabQuickReports : t.appName)}</h1>
          <LanguageToggle />
          <ThemeMenu />
        </header>
        <div role="tablist" aria-label={t.tabsLabel} className="flex shrink-0 gap-1 border-b px-3 md:px-4">
          {TABS.map((kind) => {
            const selected = kind === tab;
            const Icon = kind === "quickReport" ? FileText : MessageSquare;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                id={`tab-${kind}`}
                aria-selected={selected}
                aria-controls="tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(kind)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const next = TABS[(TABS.indexOf(kind) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                  selectTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }}
                className={cn(
                  "-mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:flex-none",
                  selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {tabLabel(kind)}
              </button>
            );
          })}
        </div>
        <ScopeBar scope={scope} onChange={changeScope} disabled={pending} />

        <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-8 px-4 py-8 text-center">
              <div className="flex flex-col items-center gap-4">
                <BrandMark className="size-14 rounded-2xl" />
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">{quickReports ? t.quickReportTitle : t.welcomeTitle}</h2>
                  <p className="mt-1.5 text-sm text-muted-foreground">{quickReports ? t.quickReportSub : t.welcomeSub}</p>
                </div>
              </div>

              <ul className="grid w-full gap-3 sm:grid-cols-3">
                {(quickReports ? t.quickReportExamples : t.examples).map((question, i) => {
                  const icons = quickReports ? QUICK_REPORT_ICONS : EXAMPLE_ICONS;
                  const Icon = icons[i % icons.length];
                  return (
                    <li key={question}>
                      <button
                        onClick={() => sendMessage(question)}
                        className="group flex h-full w-full flex-col items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                      >
                        <span className="flex items-center gap-2 text-xs font-medium text-primary">
                          <Icon className="size-4" />
                          {(quickReports ? t.quickReportLabels : t.exampleLabels)[i]}
                        </span>
                        <span className="text-sm leading-snug">{question}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Paperclip className="size-3.5" />
                {quickReports ? t.quickReportHint : t.hintFiles}
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-8 px-4 py-8" role="log" aria-live="polite">
              {messages.map((m, i) => {
                const isLast = i === messages.length - 1;
                return (
                  <MessageItem
                    key={m.id}
                    message={m}
                    showFollowUps={!pending && isLast}
                    onFollowUp={(q) => sendMessage(q)}
                    onRetry={isLast && canRetry ? retryLast : undefined}
                    question={m.role === "assistant" ? messages.slice(0, i).reverse().find((x) => x.role === "user")?.content : undefined}
                    scope={scope}
                    context={m.role === "assistant" ? chatContext(messages, i) : undefined}
                    onRefresh={isLast && canRefresh ? refreshAnswer : undefined}
                  />
                );
              })}
              {nextStepsDesign && <QuickReportNextSteps key={messages[messages.length - 1].id} design={nextStepsDesign} />}
              {pending && <ThinkingIndicator />}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <Composer key={tab} onSend={sendMessage} disabled={pending} placeholder={quickReports ? t.quickReportPlaceholder : undefined} />
      </main>
    </div>
  );
}
