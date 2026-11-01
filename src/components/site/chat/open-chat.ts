/**
 * Opening the website chat from elsewhere on the page (the AI assistant teaser's question
 * chips, 06 §3 item 6), and hiding its button on pages that ask for it (06 §2). The chat
 * button listens for these window events, so the page sections stay server components.
 */
export const OPEN_CHAT_EVENT = "propel:open-chat";
export const HIDE_CHAT_EVENT = "propel:hide-chat";

export type OpenChatDetail = { prompt?: string };
export type HideChatDetail = { hidden: boolean };

export function openChat(prompt?: string): void {
  window.dispatchEvent(new CustomEvent<OpenChatDetail>(OPEN_CHAT_EVENT, { detail: { prompt } }));
}
