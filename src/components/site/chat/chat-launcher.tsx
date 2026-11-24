"use client";

import { MessageCircleIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { chat as t } from "@/lib/i18n/dictionaries/chat";
import {
  HIDE_CHAT_EVENT,
  OPEN_CHAT_EVENT,
  type HideChatDetail,
  type OpenChatDetail,
} from "./open-chat";

// The panel's code loads only when someone opens the chat (no cost on first paint).
const ChatPanel = dynamic(() => import("./chat-panel").then((m) => m.ChatPanel), { ssr: false });

/**
 * The chat button on every site page (09 §1 #3); shown only when Settings turns it on.
 * Other parts of the page open it with a question (`openChat`), and a page can hide the
 * button (`HideChat`).
 */
export function ChatLauncher(props: {
  title: string;
  greeting: string;
  askContactFirst: boolean;
  humanButton: "always" | "after_3";
}) {
  const [open, setOpen] = useState<{ prompt: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const onOpen = (e: Event) =>
      setOpen({ prompt: (e as CustomEvent<OpenChatDetail>).detail?.prompt ?? "" });
    const onHide = (e: Event) => setHidden((e as CustomEvent<HideChatDetail>).detail.hidden);
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    window.addEventListener(HIDE_CHAT_EVENT, onHide);
    return () => {
      window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
      window.removeEventListener(HIDE_CHAT_EVENT, onHide);
    };
  }, []);

  // Closing the chat puts the keyboard focus back on the button that opened it.
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) button.current?.focus();
  }, [open]);

  if (open)
    return (
      <ChatPanel
        // A new question from a chip starts the panel again with that question typed in.
        key={open.prompt}
        {...props}
        initialText={open.prompt}
        onClose={() => setOpen(null)}
      />
    );
  if (hidden) return null;
  return (
    <button
      ref={button}
      type="button"
      onClick={() => setOpen({ prompt: "" })}
      aria-haspopup="dialog"
      className="group fixed end-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-30 inline-flex h-12 items-center gap-2.5 rounded-full bg-ink ps-1.5 pe-5 text-[14px] font-semibold text-surface shadow-[0_10px_30px_-8px_rgba(20,35,43,0.45)] transition-[transform,background-color] duration-150 hover:-translate-y-0.5 hover:bg-ink-soft motion-reduce:transition-none lg:end-6 lg:bottom-6 print:hidden"
    >
      <span className="relative grid size-9 place-items-center rounded-full bg-surface/12">
        <MessageCircleIcon className="size-[18px]" aria-hidden />
        <span
          aria-hidden
          className="absolute end-0.5 top-0.5 size-2.5 rounded-full bg-success ring-2 ring-ink"
        />
      </span>
      {t.open}
    </button>
  );
}
