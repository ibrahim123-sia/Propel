"use client";

import { MessageCircleIcon } from "lucide-react";
import { useEffect } from "react";
import { HIDE_CHAT_EVENT, openChat, type HideChatDetail } from "./open-chat";

/** Rendered by a page whose settings hide the chat button (06 §2); it comes back on leaving. */
export function HideChat() {
  useEffect(() => {
    const send = (hidden: boolean) => {
      window.dispatchEvent(
        new CustomEvent<HideChatDetail>(HIDE_CHAT_EVENT, { detail: { hidden } }),
      );
    };
    send(true);
    return () => send(false);
  }, []);
  return null;
}

/** The AI assistant teaser's question chips: each opens the chat with its question typed in. */
export function ChatPromptChips({ prompts, label }: { prompts: string[]; label: string }) {
  return (
    <ul aria-label={label} className="mt-6 flex flex-wrap gap-2">
      {prompts.map((p) => (
        <li key={p}>
          <button
            type="button"
            onClick={() => openChat(p)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-[14px] text-ink hover:border-ink/40"
          >
            <MessageCircleIcon className="size-4 text-accent" aria-hidden />
            {p}
          </button>
        </li>
      ))}
    </ul>
  );
}
