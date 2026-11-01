"use client";

import { MessageCircleIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
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
      type="button"
      onClick={() => setOpen({ prompt: "" })}
      aria-haspopup="dialog"
      className="fixed end-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-30 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-3 text-[14px] font-semibold text-surface shadow-pin hover:bg-ink-soft lg:bottom-6 print:hidden"
    >
      <MessageCircleIcon className="size-4" aria-hidden />
      {t.open}
    </button>
  );
}
