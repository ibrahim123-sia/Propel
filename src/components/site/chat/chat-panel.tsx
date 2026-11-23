"use client";

import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { askForPerson, saveChatContact, sendChatMessage, startChat } from "@/features/chat/actions";
import type { ChatCard, ChatMessage } from "@/features/chat/schema";
import { CHAT_CONTACT_ASK_AFTER, CHAT_CONTACT_REQUIRED_AFTER } from "@/features/chat/limits";
import { chat as t } from "@/lib/i18n/dictionaries/chat";

type Status = "ai" | "needs_human" | "human" | "closed";
type Poll = {
  enabled: boolean;
  conversation: {
    id: string;
    status: Status;
    hasContact: boolean;
    visitorMessages: number;
  } | null;
  messages: ChatMessage[];
};

/** While the assistant writes, the window checks more often (for up to a minute). */
const FAST_POLL_MS = 1500;
const FAST_POLL_FOR_MS = 60_000;
const SLOW_POLL_MS = 5000;

/** The page the chat was opened on, so the assistant knows what the visitor is looking at. */
const pagePath = () => `${window.location.pathname}${window.location.search}`.slice(0, 500);

const field =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 text-[15px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** Listings the assistant showed, with live prices (10 §2: cards instead of long text). */
function Cards({ cards }: { cards: ChatCard[] }) {
  return (
    <ul aria-label={t.listings} className="mt-2 flex flex-col gap-2">
      {cards.map((c) => (
        <li key={c.id}>
          <a
            href={c.href}
            className="flex gap-3 rounded-xl border border-border bg-surface p-2 text-ink hover:border-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            {c.photo && (
              // eslint-disable-next-line @next/next/no-img-element -- a small /media thumbnail
              <img
                src={`${c.photo.url}${c.photo.url.includes("?") ? "&" : "?"}w=256`}
                alt=""
                width={64}
                height={48}
                loading="lazy"
                className="h-12 w-16 shrink-0 rounded-md object-cover"
              />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-semibold">{c.title}</span>
              <span className="text-[13px]">{c.price}</span>
              <span className="truncate text-[12px] text-text-muted">{c.facts}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The chat window (09 §1 #3): the first message (with name and email or phone when Settings
 * asks) starts a conversation in the inbox; replies appear here, polled every few seconds.
 */
export function ChatPanel({
  title,
  greeting,
  askContactFirst,
  humanButton,
  initialText = "",
  onClose,
}: {
  title: string;
  greeting: string;
  askContactFirst: boolean;
  humanButton: "always" | "after_3";
  /** A question to start with (a teaser chip): typed in, for the visitor to send. */
  initialText?: string;
  onClose: () => void;
}) {
  const [started, setStarted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const fastUntil = useRef(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    message: initialText,
    website: "",
  });
  const [text, setText] = useState(initialText);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState({ hasContact: true, visitorMessages: 0 });
  /** The visitor's message count when they closed the details form (it returns later). */
  const [dismissedAt, setDismissedAt] = useState(0);
  const [details, setDetails] = useState({ name: "", phone: "", email: "", website: "" });
  const [detailsErrors, setDetailsErrors] = useState<Record<string, string[]>>({});
  const last = useRef<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLLIElement>(null);

  const load = useCallback(async (full = false) => {
    try {
      const after = !full && last.current ? `?after=${encodeURIComponent(last.current)}` : "";
      const res = await fetch(`/api/chat${after}`, { cache: "no-store" });
      const data = (await res.json()) as Poll;
      if (!data.conversation) return setStarted(false);
      setStarted(true);
      setStatus(data.conversation.status);
      setContact({
        hasContact: data.conversation.hasContact,
        visitorMessages: data.conversation.visitorMessages,
      });
      if (data.messages.length) {
        last.current = data.messages.at(-1)!.createdAt;
        setMessages((cur) =>
          full
            ? data.messages
            : [...cur, ...data.messages.filter((m) => !cur.some((c) => c.id === m.id))],
        );
      }
    } catch {
      // Offline for a moment: the next poll tries again.
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    let first = true;
    const tick = () => {
      if (first || document.visibilityState === "visible") void load(first);
      first = false;
      timer = window.setTimeout(tick, Date.now() < fastUntil.current ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    timer = window.setTimeout(tick, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, [started]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, contact.visitorMessages]);

  const submitStart = async () => {
    setBusy(true);
    setError(null);
    const res = await startChat({ ...form, page: pagePath() }).catch(() => null);
    setBusy(false);
    if (!res) return setError(t.failed);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      return setError(res.error);
    }
    setErrors({});
    fastUntil.current = Date.now() + FAST_POLL_FOR_MS;
    await load(true);
  };
  const submitMessage = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await sendChatMessage({ text, page: pagePath() }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(res && !res.ok ? res.error : t.failed);
    setText("");
    fastUntil.current = Date.now() + FAST_POLL_FOR_MS;
    await load();
  };
  const submitPerson = async () => {
    setBusy(true);
    setError(null);
    const res = await askForPerson().catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(res && !res.ok ? res.error : t.failed);
    fastUntil.current = Date.now() + FAST_POLL_FOR_MS;
    await load();
  };
  const submitDetails = async () => {
    setBusy(true);
    setError(null);
    const res = await saveChatContact({ ...details, page: pagePath() }).catch(() => null);
    setBusy(false);
    if (!res) return setError(t.failed);
    if (!res.ok) return setDetailsErrors(res.fieldErrors ?? { name: [res.error] });
    setDetailsErrors({});
    setContact((c) => ({ ...c, hasContact: true }));
    fastUntil.current = Date.now() + FAST_POLL_FOR_MS;
    await load();
  };
  const sent = contact.visitorMessages;
  const required = sent >= CHAT_CONTACT_REQUIRED_AFTER;
  const step = required
    ? sent
    : ([...CHAT_CONTACT_ASK_AFTER].reverse().find((n) => sent >= n) ?? 0);
  const showDetails = started === true && !contact.hasContact && step > 0 && dismissedAt < step;
  const lastMine = messages.at(-1)?.mine ?? false;
  const sentByMe = messages.filter((m) => m.mine).length;
  const showPerson =
    status === "ai" && messages.length > 0 && (humanButton === "always" || sentByMe >= 3);
  const err = (k: string) =>
    errors[k]?.[0] ? <span className="text-[13px] text-red-700">{errors[k]![0]}</span> : null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed inset-x-0 bottom-0 z-[45] flex max-h-[85dvh] flex-col rounded-t-[20px] border border-border bg-surface shadow-soft sm:inset-x-auto sm:end-6 sm:bottom-6 sm:w-[24rem] sm:rounded-[20px] print:hidden"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="font-display text-[18px] text-ink">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="ms-auto rounded-full p-1.5 hover:bg-surface-muted"
        >
          <XIcon className="size-5" aria-hidden />
        </button>
      </header>
      <ol
        aria-label={title}
        className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3 text-[15px]"
      >
        <li className="max-w-[85%] self-start rounded-2xl bg-surface-muted px-3 py-2 text-ink">
          {greeting}
        </li>
        {messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              "max-w-[85%] rounded-2xl px-3 py-2 whitespace-pre-wrap",
              m.mine ? "self-end bg-ink text-surface" : "self-start bg-surface-muted text-ink",
            )}
          >
            <span className="sr-only">
              {m.mine ? t.you : m.sender === "ai" ? t.assistant : t.team}:{" "}
            </span>
            {m.body}
            {m.cards.length > 0 && <Cards cards={m.cards} />}
          </li>
        ))}
        {showDetails && (
          <li className="self-stretch">
            <form
              aria-label={t.contactTitle}
              className="relative flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitDetails();
              }}
            >
              <button
                type="button"
                onClick={() => setDismissedAt(step)}
                aria-label={t.contactLater}
                className="absolute end-2 top-2 rounded-full p-1 hover:bg-surface-muted"
              >
                <XIcon className="size-4" aria-hidden />
              </button>
              <p className="pe-6 text-[14px] font-semibold text-ink">{t.contactTitle}</p>
              <p className="text-[13px] text-text-muted">
                {required ? t.contactRequired : t.contactText}
              </p>
              <input
                className={field}
                aria-label={t.name}
                placeholder={t.name}
                autoComplete="name"
                value={details.name}
                onChange={(e) => setDetails({ ...details, name: e.target.value })}
              />
              {detailsErrors.name?.[0] && (
                <span className="text-[13px] text-red-700">{detailsErrors.name[0]}</span>
              )}
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={field}
                  type="tel"
                  aria-label={t.phone}
                  placeholder={t.phone}
                  autoComplete="tel"
                  value={details.phone}
                  onChange={(e) => setDetails({ ...details, phone: e.target.value })}
                />
                <input
                  className={field}
                  type="email"
                  aria-label={t.email}
                  placeholder={t.email}
                  autoComplete="email"
                  value={details.email}
                  onChange={(e) => setDetails({ ...details, email: e.target.value })}
                />
              </div>
              {(detailsErrors.phone?.[0] ?? detailsErrors.email?.[0]) && (
                <span className="text-[13px] text-red-700">
                  {detailsErrors.phone?.[0] ?? detailsErrors.email?.[0]}
                </span>
              )}
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden
                className="hidden"
                value={details.website}
                onChange={(e) => setDetails({ ...details, website: e.target.value })}
              />
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-full bg-ink px-4 py-2 text-[14px] font-semibold text-surface disabled:opacity-60"
                >
                  {busy ? t.contactSaving : t.contactSave}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedAt(step)}
                  className="text-[13px] font-semibold text-text-muted underline underline-offset-2"
                >
                  {t.contactLater}
                </button>
              </div>
            </form>
          </li>
        )}
        {started && lastMine && status === "ai" && !required && (
          <li className="self-start text-[13px] text-text-muted" role="status">
            {t.typing}
          </li>
        )}
        {started && status !== "ai" && messages.length > 0 && messages.every((m) => m.mine) && (
          <li className="self-start text-[13px] text-text-muted">{t.waiting}</li>
        )}
        <li ref={end} aria-hidden />
      </ol>
      {started === false && (
        <form
          className="flex flex-col gap-2 border-t border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitStart();
          }}
        >
          {askContactFirst && <p className="text-[13px] text-text-muted">{t.intro}</p>}
          {askContactFirst && (
            <>
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
                {t.name}
                <input
                  className={field}
                  value={form.name}
                  autoComplete="name"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                {err("name")}
              </label>
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
                {t.email}
                <input
                  className={field}
                  type="email"
                  value={form.email}
                  autoComplete="email"
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                {err("email")}
              </label>
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
                {t.phone}
                <input
                  className={field}
                  type="tel"
                  value={form.phone}
                  autoComplete="tel"
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
                {err("phone")}
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
            {t.message}
            <textarea
              className={field}
              rows={3}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
            {err("message")}
          </label>
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden
            className="hidden"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
          {error && <p className="text-[13px] text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-ink px-4 py-2.5 text-[15px] font-semibold text-surface disabled:opacity-60"
          >
            {t.start}
          </button>
        </form>
      )}
      {started && showPerson && (
        <button
          type="button"
          onClick={() => void submitPerson()}
          disabled={busy}
          className="mx-3 mt-2 self-start rounded-full border border-border px-3 py-1.5 text-[13px] font-semibold text-ink hover:border-ink disabled:opacity-60"
        >
          {t.person}
        </button>
      )}
      {started && (
        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitMessage();
          }}
        >
          <textarea
            className={cn(field, "min-h-11 flex-1")}
            rows={1}
            aria-label={t.message}
            placeholder={t.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitMessage();
              }
            }}
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="rounded-full bg-ink px-4 py-2.5 text-[15px] font-semibold text-surface disabled:opacity-60"
          >
            {t.send}
          </button>
        </form>
      )}
      {started && error && <p className="px-4 pb-3 text-[13px] text-red-700">{error}</p>}
    </div>
  );
}
