"use client";

import { GlobeIcon, MailIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { EmptyState } from "@/components/admin/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { decideApproval, flagAssistantAnswer, updateConversation } from "@/features/inbox/actions";
import type {
  ApprovalItem,
  ConversationDetail,
  ConversationListItem,
  InboxFilter,
  QuickReply,
} from "@/features/inbox/queries";
import { inbox as t } from "@/lib/i18n/dictionaries/inbox";
import { format } from "@/lib/i18n";
import { useAction } from "@/lib/use-action";
import { Composer, type TemplateOption } from "./composer";
import { QuickRepliesPanel } from "./quick-replies-panel";

const channelIcon = { web_chat: GlobeIcon, whatsapp: MessageCircleIcon, email: MailIcon } as const;
const statusTabs = ["open", "needs_human", "ai", "human", "closed", "all"] as const;

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Builds an inbox URL from the current filter with some values changed. */
function hrefWith(
  filter: InboxFilter,
  change: Record<string, string | null>,
  keep?: string | null,
) {
  const p = new URLSearchParams();
  if (filter.status !== "open") p.set("status", filter.status);
  if (filter.channel !== "all") p.set("channel", filter.channel);
  if (filter.q) p.set("q", filter.q);
  if (filter.unread) p.set("unread", "1");
  if (keep) p.set("c", keep);
  for (const [k, v] of Object.entries(change)) {
    if (v === null || v === "") p.delete(k);
    else p.set(k, v);
  }
  const s = p.toString();
  return s ? `/admin/inbox?${s}` : "/admin/inbox";
}

export function InboxView({
  filter,
  view,
  list,
  counts,
  selected,
  approvals,
  quickReplies,
  templates,
  readOnly,
}: {
  filter: InboxFilter;
  view: "conversations" | "approvals";
  list: ConversationListItem[];
  counts: { needsHuman: number; unread: number; approvals: number };
  selected: ConversationDetail | null;
  approvals: ApprovalItem[];
  quickReplies: QuickReply[];
  templates: TemplateOption[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(filter.q);
  const [panel, setPanel] = useState(false);
  const selectedId = selected?.conversation.id ?? null;

  // New messages arrive by webhook: refresh while the tab is visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [router]);

  // Opening a conversation reads it.
  const markRead = useAction(updateConversation);
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || readOnly || selected.conversation.unreadCount === 0) return;
    if (marked.current === selected.conversation.id) return;
    marked.current = selected.conversation.id;
    void markRead.run({ id: selected.conversation.id, action: "mark_read" });
  }, [selected, readOnly, markRead]);

  return (
    <div className="grid min-h-[70dvh] overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-[22rem_1fr]">
      <aside
        aria-label={t.title}
        className="flex min-h-0 flex-col border-b border-border lg:border-e lg:border-b-0"
      >
        <nav aria-label="Inbox views" className="flex gap-1 border-b border-border p-2">
          <Link
            href={hrefWith(filter, { view: null })}
            aria-current={view === "conversations" ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium",
              view === "conversations" ? "bg-muted" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t.title}
            {counts.unread > 0 && <Badge className="ms-1.5">{counts.unread}</Badge>}
          </Link>
          <Link
            href={hrefWith(filter, { view: "approvals" })}
            aria-current={view === "approvals" ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium",
              view === "approvals" ? "bg-muted" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t.approvals.tab}
            {counts.approvals > 0 && (
              <Badge variant="secondary" className="ms-1.5">
                {counts.approvals}
              </Badge>
            )}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            onClick={() => setPanel(true)}
            disabled={readOnly}
          >
            {t.actions.quickReplies}
          </Button>
        </nav>

        <div className="flex flex-col gap-2 border-b border-border p-2">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              router.push(hrefWith(filter, { q: q.trim() || null }));
            }}
            className="relative"
          >
            <SearchIcon
              className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.filters.search}
              aria-label={t.filters.search}
              className="ps-8"
            />
          </form>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
            {statusTabs.map((s) => (
              <Link
                key={s}
                href={hrefWith(filter, { status: s === "open" ? null : s })}
                aria-current={filter.status === s ? "true" : undefined}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs",
                  filter.status === s
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {s === "open" ? t.filters.open : s === "all" ? t.filters.all : t.statuses[s]}
                {s === "needs_human" && counts.needsHuman > 0 ? ` (${counts.needsHuman})` : ""}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="sr-only">{t.filters.channel}</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1"
                value={filter.channel}
                aria-label={t.filters.channel}
                onChange={(e) =>
                  router.push(
                    hrefWith(filter, { channel: e.target.value === "all" ? null : e.target.value }),
                  )
                }
              >
                <option value="all">{t.filters.allChannels}</option>
                {(["whatsapp", "web_chat", "email"] as const).map((c) => (
                  <option key={c} value={c}>
                    {t.channels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={filter.unread}
                onChange={(e) =>
                  router.push(hrefWith(filter, { unread: e.target.checked ? "1" : null }))
                }
              />
              {t.filters.unread}
            </label>
          </div>
        </div>

        {list.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t.empty.list}</p>
        ) : (
          <ul
            aria-label="Conversations"
            className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
          >
            {list.map((c) => {
              const Icon = channelIcon[c.channel];
              const active = c.id === selectedId;
              return (
                <li key={c.id}>
                  <Link
                    href={hrefWith(filter, { c: c.id, view: null })}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex flex-col gap-0.5 px-3 py-2.5 hover:bg-muted/60",
                      active && "bg-muted",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-label={t.channels[c.channel]}
                      />
                      <span
                        className={cn(
                          "truncate text-sm",
                          c.unreadCount > 0 ? "font-semibold" : "font-medium",
                        )}
                      >
                        {c.contactName ?? c.contactDetail ?? t.channels[c.channel]}
                      </span>
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                        {when(c.lastMessageAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="line-clamp-1 flex-1 text-xs text-muted-foreground">
                        {c.lastSender && c.lastSender !== "customer"
                          ? `${t.senders[c.lastSender]}: `
                          : ""}
                        {c.lastBody ?? c.subject ?? ""}
                      </span>
                      {c.unreadCount > 0 && (
                        <Badge aria-label={`${c.unreadCount} unread`}>{c.unreadCount}</Badge>
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t.statuses[c.status]}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section
        className="flex min-h-0 flex-col"
        aria-label={view === "approvals" ? t.approvals.tab : "Conversation"}
      >
        {view === "approvals" ? (
          <Approvals items={approvals} readOnly={readOnly} />
        ) : selected ? (
          <ConversationPane
            detail={selected}
            quickReplies={quickReplies}
            templates={templates}
            readOnly={readOnly}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState title={t.empty.pick} />
          </div>
        )}
      </section>

      <QuickRepliesPanel open={panel} onOpenChange={setPanel} items={quickReplies} />
    </div>
  );
}

function ConversationPane({
  detail,
  quickReplies,
  templates,
  readOnly,
}: {
  detail: ConversationDetail;
  quickReplies: QuickReply[];
  templates: TemplateOption[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const { conversation: conv, contact, lead } = detail;
  const update = useAction(updateConversation, { onSuccess: () => router.refresh() });
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail.messages.length]);
  const act = (action: "take_over" | "hand_back" | "close" | "reopen", success: string) =>
    update.run({ id: conv.id, action }).then((r) => r.ok && toast.success(success));

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            {contact?.name ?? t.channels[conv.channel]}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t.channels[conv.channel]} ·{" "}
            {contact?.whatsapp || contact?.phone || contact?.email || ""} ·{" "}
            <span>{t.statuses[conv.status]}</span>
            {conv.channel === "whatsapp" &&
              conv.waWindowExpiresAt &&
              new Date(conv.waWindowExpiresAt) > new Date() && (
                <>
                  {" "}
                  ·{" "}
                  {format(t.windowOpenUntil, {
                    time: new Date(conv.waWindowExpiresAt).toLocaleString(),
                  })}
                </>
              )}
          </p>
        </div>
        <div className="ms-auto flex flex-wrap gap-2">
          {lead ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/leads/${lead.id}`}>{t.actions.openLead}</Link>
            </Button>
          ) : (
            <span className="self-center text-xs text-muted-foreground">{t.unassigned}</span>
          )}
          {!readOnly && conv.status !== "closed" && conv.status !== "human" && (
            <Button
              size="sm"
              onClick={() => act("take_over", t.toasts.takenOver)}
              disabled={update.pending}
            >
              {t.actions.takeOver}
            </Button>
          )}
          {!readOnly && conv.status === "human" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => act("hand_back", t.toasts.handedBack)}
              disabled={update.pending}
            >
              {t.actions.handBack}
            </Button>
          )}
          {!readOnly &&
            (conv.status === "closed" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => act("reopen", t.toasts.reopened)}
                disabled={update.pending}
              >
                {t.actions.reopen}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => act("close", t.toasts.closed)}
                disabled={update.pending}
              >
                {t.actions.close}
              </Button>
            ))}
        </div>
      </header>

      <ol
        aria-label="Messages"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {detail.messages.map((m) => {
          const mine = m.direction === "out";
          return (
            <li
              key={m.id}
              className={cn(
                "flex max-w-[80%] flex-col gap-1",
                mine ? "items-end self-end" : "self-start",
              )}
            >
              {m.toolCalls.map((tc, i) => (
                <span key={i} className="text-[11px] text-muted-foreground">
                  {tc.tool}: {tc.summary}
                </span>
              ))}
              <div
                className={cn(
                  "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                  mine ? "bg-primary/10" : "bg-muted",
                )}
              >
                {m.body}
                {m.attachments.map((a, i) =>
                  a.url && /^https?:/.test(a.url) ? (
                    <a
                      key={i}
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 block text-xs underline"
                    >
                      {a.name}
                    </a>
                  ) : (
                    <span key={i} className="mt-1 block text-xs text-muted-foreground">
                      {a.name}
                    </span>
                  ),
                )}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {t.senders[m.sender]}
                {m.senderName ? ` (${m.senderName})` : ""} · {when(m.createdAt)}
                {mine && ` · ${t.messageStatus[m.status]}`}
                {m.error && <span className="block text-destructive">{m.error}</span>}
              </span>
              {m.sender === "ai" && m.direction === "out" && (
                <AnswerFlag messageId={m.id} flag={m.flag} readOnly={readOnly} />
              )}
            </li>
          );
        })}
        <div ref={bottom} />
      </ol>

      {detail.approvals.length > 0 && (
        <div className="border-t border-border bg-muted/40 px-4 py-2">
          <Approvals
            items={detail.approvals.map((a) => ({
              ...a,
              conversationId: conv.id,
              channel: conv.channel,
              contactName: contact?.name ?? null,
            }))}
            readOnly={readOnly}
            compact
          />
        </div>
      )}
      {!readOnly && conv.status !== "closed" && (
        <Composer
          conversationId={conv.id}
          channel={conv.channel}
          windowExpiresAt={conv.waWindowExpiresAt}
          contactName={contact?.name ?? ""}
          quickReplies={quickReplies}
          templates={templates}
        />
      )}
    </>
  );
}

function Approvals({
  items,
  readOnly,
  compact,
}: {
  items: Array<
    Pick<
      ApprovalItem,
      "id" | "conversationId" | "draftReply" | "reason" | "createdAt" | "channel" | "contactName"
    >
  >;
  readOnly: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const decide = useAction(decideApproval, { onSuccess: () => router.refresh() });
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  if (items.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">{t.empty.approvals}</p>;
  return (
    <ul
      aria-label={t.approvals.tab}
      className={cn("flex flex-col gap-3", compact ? "" : "overflow-y-auto p-4")}
    >
      {items.map((a) => (
        <li key={a.id} className="rounded-md border border-border bg-background p-3">
          {!compact && (
            <p className="mb-1 text-sm font-medium">
              <Link
                href={`/admin/inbox?c=${a.conversationId}`}
                className="underline-offset-4 hover:underline"
              >
                {a.contactName ?? t.channels[a.channel]}
              </Link>{" "}
              <span className="text-xs text-muted-foreground">· {t.channels[a.channel]}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t.approvals.reason}: {a.reason}
          </p>
          {editing === a.id ? (
            <Textarea
              className="mt-2"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={t.approvals.draft}
            />
          ) : (
            <p className="mt-2 text-sm whitespace-pre-wrap">{a.draftReply}</p>
          )}
          {!readOnly && (
            <div className="mt-2 flex flex-wrap gap-2">
              {editing === a.id ? (
                <Button
                  size="sm"
                  disabled={decide.pending}
                  onClick={() =>
                    decide
                      .run({ id: a.id, decision: "edit", text })
                      .then((r) => r.ok && setEditing(null))
                  }
                >
                  {t.actions.edit}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={decide.pending}
                    onClick={() => decide.run({ id: a.id, decision: "approve" })}
                  >
                    {t.actions.approve}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(a.id);
                      setText(a.draftReply);
                    }}
                  >
                    {t.actions.edit}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={decide.pending}
                onClick={() => decide.run({ id: a.id, decision: "reject" })}
              >
                {t.actions.reject}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 10 §2: flag an assistant answer that was wrong (with a short note on what), to improve the
 * prompts; the AI report counts flags. A flag can be taken back.
 */
function AnswerFlag({
  messageId,
  flag,
  readOnly,
}: {
  messageId: string;
  flag: { at: string; note: string | null } | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const save = useAction(flagAssistantAnswer, {
    onSuccess: () => {
      setOpen(false);
      setNote("");
      router.refresh();
    },
  });
  if (flag)
    return (
      <span className="flex flex-wrap items-center gap-2 text-[11px] text-destructive">
        {t.flag.flagged}
        {flag.note ? `: ${flag.note}` : ""}
        {!readOnly && (
          <button
            type="button"
            className="underline"
            disabled={save.pending}
            onClick={() => save.run({ messageId, flagged: false, note: null })}
          >
            {t.flag.remove}
          </button>
        )}
      </span>
    );
  if (readOnly) return null;
  if (!open)
    return (
      <button
        type="button"
        className="text-[11px] text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        {t.flag.open}
      </button>
    );
  return (
    <form
      className="flex w-full max-w-sm items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run({ messageId, flagged: true, note: note || null });
      }}
    >
      <Input
        aria-label={t.flag.noteLabel}
        placeholder={t.flag.notePlaceholder}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" variant="outline" disabled={save.pending}>
        {t.flag.save}
      </Button>
    </form>
  );
}
