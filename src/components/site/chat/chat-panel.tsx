"use client";

import {
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContactRoundIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
const fastPollUntil = () => Date.now() + FAST_POLL_FOR_MS;

/** The composer grows with the text up to about five lines, then scrolls. */
const COMPOSER_MAX_PX = 132;

/** The page the chat was opened on, so the assistant knows what the visitor is looking at. */
const pagePath = () => `${window.location.pathname}${window.location.search}`.slice(0, 500);

/** 16px on phones so iOS does not zoom into the field. */
const field =
  "h-10 w-full rounded-xl border border-border bg-surface px-3 text-[16px] text-ink outline-none transition-colors placeholder:text-text-muted focus-visible:border-ink/40 focus-visible:ring-4 focus-visible:ring-ink/5 sm:text-[14px]";

const photoUrl = (url: string, w: number) => `${url}${url.includes("?") ? "&" : "?"}w=${w}`;

/** The booking straight from a card: the listing or project page opens its "Book a tour". */
const tourHref = (href: string) => `${href}${href.includes("?") ? "&" : "?"}tour=1`;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Avatar({ title, size = "md" }: { title: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-ink font-display text-surface",
        size === "md" ? "size-10 text-[17px]" : "size-7 text-[13px]",
      )}
    >
      {title.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Listings the assistant showed, with live prices (10 §2: cards instead of long text), side by
 * side in a row that scrolls sideways: photo with the price on it, title and facts, then Open
 * and Book tour. Arrows page through the row with a mouse; touch swipes it.
 */
function Cards({ cards }: { cards: ChatCard[] }) {
  const row = useRef<HTMLUListElement>(null);
  const page = (dir: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const card = el.querySelector("li")?.getBoundingClientRect().width ?? 240;
    const rtl = getComputedStyle(el).direction === "rtl" ? -1 : 1;
    el.scrollBy({ left: dir * rtl * (card + 12), behavior: "smooth" });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between ps-9">
        <p className="text-[12px] font-semibold tracking-wide text-text-muted uppercase">
          {cards.length === 1 ? t.oneHome : t.homesCount.replace("{n}", String(cards.length))}
        </p>
        {cards.length > 1 && (
          <div className="hidden gap-1 sm:flex">
            <button
              type="button"
              onClick={() => page(-1)}
              aria-label={t.previousHomes}
              className="grid size-7 place-items-center rounded-full border border-border bg-surface text-ink hover:border-ink/40"
            >
              <ChevronLeftIcon className="size-4 rtl:rotate-180" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => page(1)}
              aria-label={t.nextHomes}
              className="grid size-7 place-items-center rounded-full border border-border bg-surface text-ink hover:border-ink/40"
            >
              <ChevronRightIcon className="size-4 rtl:rotate-180" aria-hidden />
            </button>
          </div>
        )}
      </div>
      <ul
        ref={row}
        aria-label={t.listings}
        className="-mx-4 flex snap-x snap-mandatory scroll-ps-13 [scrollbar-width:none] gap-3 overflow-x-auto ps-13 pe-4 pb-1 [&::-webkit-scrollbar]:hidden"
      >
        {cards.map((c) => (
          <li
            key={c.id}
            className="flex w-[14.5rem] shrink-0 snap-start flex-col overflow-hidden rounded-[18px] border border-border bg-surface"
          >
            <a href={c.href} className="relative block" tabIndex={-1} aria-hidden>
              {c.photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a /media variant sized for the card
                <img
                  src={photoUrl(c.photo.url, 384)}
                  alt=""
                  width={232}
                  height={145}
                  loading="lazy"
                  className="aspect-[16/10] w-full bg-photo-placeholder object-cover"
                />
              ) : (
                <span className="block aspect-[16/10] w-full bg-photo-placeholder" />
              )}
            </a>
            <div className="flex flex-1 flex-col gap-0.5 px-3 pt-2.5 pb-3">
              <p className="text-[15px] font-bold text-ink tabular-nums">{c.price}</p>
              <a
                href={c.href}
                className="line-clamp-2 text-[13.5px] leading-snug font-medium text-ink hover:underline"
              >
                {c.title}
              </a>
              <p className="truncate text-[12px] text-text-muted">{c.facts}</p>
              <div className="mt-auto grid grid-cols-2 gap-2 pt-2.5">
                <a
                  href={c.href}
                  className="grid h-9 place-items-center rounded-full border border-border text-[13px] font-semibold text-ink transition-colors hover:border-ink/50"
                >
                  {t.cardOpen}
                </a>
                <a
                  href={tourHref(c.href)}
                  className="grid h-9 place-items-center rounded-full bg-ink text-[13px] font-semibold text-surface transition-colors hover:bg-ink-soft"
                >
                  {t.cardTour}
                </a>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A line from the agency's side: the avatar once per run of replies, then the bubble. */
function TheirLine({
  title,
  first,
  children,
}: {
  title: string;
  first: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-end gap-2">
      {first ? <Avatar title={title} size="sm" /> : <span aria-hidden className="w-7 shrink-0" />}
      {children}
    </div>
  );
}

const theirBubble =
  "max-w-[82%] rounded-[18px] rounded-bl-[6px] border border-border bg-surface px-3.5 py-2.5 text-ink whitespace-pre-wrap";

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
  const [form, setForm] = useState({ name: "", email: "", phone: "", website: "" });
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
  const composer = useRef<HTMLTextAreaElement>(null);
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
    // With the contact form first, its first field; otherwise the message box.
    const panel = composer.current?.closest('[role="dialog"]');
    const target =
      started === false && askContactFirst
        ? panel?.querySelector<HTMLElement>("input:not([tabindex='-1'])")
        : composer.current;
    target?.focus();
  }, [started, askContactFirst]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, contact.visitorMessages]);
  // The composer is one line tall and grows with what is typed.
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [text, started]);

  const startWith = async (message: string) => {
    setBusy(true);
    setError(null);
    const res = await startChat({ ...form, message, page: pagePath() }).catch(() => null);
    setBusy(false);
    if (!res) return setError(t.failed);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      return setError(res.error);
    }
    setErrors({});
    setText("");
    fastUntil.current = fastPollUntil();
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
    fastUntil.current = fastPollUntil();
    await load();
  };
  const submit = () => {
    if (busy) return;
    if (started) return void submitMessage();
    if (text.trim()) void startWith(text);
  };
  const submitPerson = async () => {
    setBusy(true);
    setError(null);
    const res = await askForPerson().catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(res && !res.ok ? res.error : t.failed);
    fastUntil.current = fastPollUntil();
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
    fastUntil.current = fastPollUntil();
    await load();
  };
  /** A suggestion starts the chat at once, unless Settings asks for details first. */
  const suggest = (prompt: string) => {
    if (askContactFirst) {
      setText(prompt);
      composer.current?.focus();
    } else void startWith(prompt);
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
  const typing = started === true && lastMine && status === "ai" && !required;
  const locked = started === true && required && !contact.hasContact;
  const err = (k: string) =>
    errors[k]?.[0] ? <span className="text-[12.5px] text-danger">{errors[k]![0]}</span> : null;
  const subtitle = status && status !== "ai" ? t.subtitleTeam : t.subtitle;

  return (
    <div
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed inset-0 z-[45] flex animate-in flex-col overflow-hidden bg-surface duration-200 fade-in slide-in-from-bottom-4 motion-reduce:animate-none sm:inset-auto sm:end-6 sm:bottom-6 sm:h-[min(46rem,calc(100dvh-3rem))] sm:w-[27rem] sm:rounded-[24px] sm:border sm:border-border sm:shadow-[0_28px_70px_-18px_rgba(20,35,43,0.35)] print:hidden"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <span className="relative">
          <Avatar title={title} />
          <span
            aria-hidden
            className="absolute -end-0.5 -bottom-0.5 size-3 rounded-full bg-success ring-2 ring-surface"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[18px] leading-tight text-ink">{title}</h2>
          <p className="truncate text-[12.5px] text-text-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.close}
          className="grid size-10 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-surface-muted"
        >
          <XIcon className="size-5" aria-hidden />
        </button>
      </header>

      <ol
        aria-label={title}
        className="flex flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface-soft px-4 py-4 text-[14.5px] leading-[1.55]"
      >
        {messages.length === 0 && (
          <li className="flex flex-col items-center gap-1.5 px-6 pt-4 pb-5 text-center">
            <Avatar title={title} />
            <p className="pt-1 font-display text-[19px] leading-tight text-ink">{t.welcomeTitle}</p>
            <p className="text-[13px] leading-snug text-text-muted">{t.welcomeText}</p>
          </li>
        )}
        <li>
          <TheirLine title={title} first>
            <p className={theirBubble}>{greeting}</p>
          </TheirLine>
        </li>

        {started === false && !askContactFirst && (
          <li className="ps-9 pt-1">
            <p className="pb-2 text-[12px] font-semibold tracking-wide text-text-muted uppercase">
              {t.suggestTitle}
            </p>
            <ul aria-label={t.suggestTitle} className="flex flex-wrap gap-2">
              {t.suggestions.map((s) => (
                <li key={s.label}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => suggest(s.prompt)}
                    className="rounded-full border border-border bg-surface px-3.5 py-2 text-[13.5px] font-medium text-ink transition-colors hover:border-ink/40 disabled:opacity-60"
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )}

        {started === false && askContactFirst && (
          <li className="ps-9">
            <div className="flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface p-3.5">
              <p className="text-[13.5px] text-text">{t.intro}</p>
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink">
                {t.name}
                <input
                  className={field}
                  value={form.name}
                  autoComplete="name"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                {err("name")}
              </label>
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink">
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
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink">
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
            </div>
          </li>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const firstOfRun = !prev || prev.mine !== m.mine || prev.sender === "system";
          if (m.sender === "system")
            return (
              <li key={m.id} className="flex justify-center py-1">
                <p className="max-w-[90%] rounded-full bg-surface-muted px-3 py-1.5 text-center text-[12.5px] leading-snug text-text">
                  {m.body}
                </p>
              </li>
            );
          return (
            <li key={m.id} className={cn("flex flex-col gap-2", firstOfRun && i > 0 && "pt-2")}>
              {m.body.trim() &&
                (m.mine ? (
                  <p className="max-w-[82%] self-end rounded-[18px] rounded-br-[6px] bg-ink px-3.5 py-2.5 whitespace-pre-wrap text-surface">
                    <span className="sr-only">{t.you}: </span>
                    {m.body}
                  </p>
                ) : (
                  <TheirLine title={title} first={firstOfRun}>
                    <p className={theirBubble}>
                      {m.sender === "admin" && firstOfRun ? (
                        <span className="block pb-0.5 text-[11.5px] font-semibold text-accent">
                          {t.team}
                        </span>
                      ) : (
                        <span className="sr-only">
                          {m.sender === "ai" ? t.assistant : t.team}:{" "}
                        </span>
                      )}
                      {m.body}
                    </p>
                  </TheirLine>
                ))}
              {m.cards.length > 0 && <Cards cards={m.cards} />}
              {m.mine && (!messages[i + 1] || !messages[i + 1].mine) && (
                <span className="self-end pe-1 text-[11px] text-text-muted">
                  {timeOf(m.createdAt)}
                </span>
              )}
            </li>
          );
        })}

        {showDetails && (
          <li className="pt-2">
            <form
              aria-label={t.contactTitle}
              className="relative flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                void submitDetails();
              }}
            >
              <div className="flex items-start gap-2.5 pe-7">
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
                >
                  <ContactRoundIcon className="size-4" />
                </span>
                <div>
                  <p className="text-[14px] leading-snug font-semibold text-ink">
                    {t.contactTitle}
                  </p>
                  <p className="text-[12.5px] leading-snug text-text-muted">
                    {required ? t.contactRequired : t.contactText}
                  </p>
                </div>
              </div>
              {!required && (
                <button
                  type="button"
                  onClick={() => setDismissedAt(step)}
                  aria-label={t.contactLater}
                  className="absolute end-2 top-2 grid size-8 place-items-center rounded-full text-text-muted hover:bg-surface-muted"
                >
                  <XIcon className="size-4" aria-hidden />
                </button>
              )}
              <input
                className={field}
                aria-label={t.name}
                placeholder={t.name}
                autoComplete="name"
                value={details.name}
                onChange={(e) => setDetails({ ...details, name: e.target.value })}
              />
              {detailsErrors.name?.[0] && (
                <span className="text-[12.5px] text-danger">{detailsErrors.name[0]}</span>
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
                <span className="text-[12.5px] text-danger">
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
              <div className="flex items-center gap-3 pt-0.5">
                <button
                  type="submit"
                  disabled={busy}
                  className="h-9 rounded-full bg-ink px-4 text-[13.5px] font-semibold text-surface transition-colors hover:bg-ink-soft disabled:opacity-60"
                >
                  {busy ? t.contactSaving : t.contactSave}
                </button>
                {!required && (
                  <button
                    type="button"
                    onClick={() => setDismissedAt(step)}
                    className="text-[13px] font-semibold text-text-muted hover:text-ink"
                  >
                    {t.contactLater}
                  </button>
                )}
              </div>
            </form>
          </li>
        )}

        {typing && (
          <li className="pt-2" role="status">
            <TheirLine title={title} first>
              <span className="flex h-10 items-center gap-1 rounded-[18px] rounded-bl-[6px] border border-border bg-surface px-4">
                <span className="sr-only">{t.typing}</span>
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    aria-hidden
                    style={{ animationDelay: `${delay}ms` }}
                    className="size-1.5 animate-bounce rounded-full bg-text-muted/70 motion-reduce:animate-none"
                  />
                ))}
              </span>
            </TheirLine>
          </li>
        )}
        {started && status !== "ai" && messages.length > 0 && messages.every((m) => m.mine) && (
          <li className="flex justify-center py-1">
            <p className="rounded-full bg-surface-muted px-3 py-1.5 text-[12.5px] text-text">
              {t.waiting}
            </p>
          </li>
        )}
        <li ref={end} aria-hidden />
      </ol>

      <form
        className="border-t border-border bg-surface px-3 pt-3 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {error && (
          <p role="alert" className="px-1 pb-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
        <div
          className={cn(
            "flex items-end gap-2 rounded-[22px] border border-border bg-surface-soft py-1.5 ps-4 pe-1.5 transition-[border-color,box-shadow] focus-within:border-ink/40 focus-within:ring-4 focus-within:ring-ink/5",
            locked && "opacity-60",
          )}
        >
          <textarea
            ref={composer}
            rows={1}
            aria-label={t.message}
            placeholder={locked ? t.lockedPlaceholder : t.placeholder}
            disabled={started === null || locked}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-[8.25rem] min-h-9 flex-1 resize-none bg-transparent py-[7px] text-[16px] leading-[22px] text-ink outline-none placeholder:text-text-muted sm:text-[14.5px]"
          />
          <button
            type="submit"
            aria-label={started ? t.send : t.start}
            disabled={busy || !text.trim() || locked}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-surface transition-colors hover:bg-ink-soft disabled:bg-surface-muted disabled:text-text-muted"
          >
            <ArrowUpIcon className="size-[18px]" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-7 items-center justify-between gap-3 px-1 pt-1.5 text-[11.5px] text-text-muted">
          <span className="truncate">{status && status !== "ai" ? t.footerTeam : t.footerAi}</span>
          {started && showPerson && (
            <button
              type="button"
              onClick={() => void submitPerson()}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-semibold text-ink transition-colors hover:bg-surface-muted disabled:opacity-60"
            >
              <UserRoundIcon className="size-3.5" aria-hidden />
              {t.person}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
