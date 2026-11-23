/**
 * When the website chat asks for the visitor's details (owner's rule, 2026-11-23): the first
 * replies are free; after the 5th and the 10th message a small, dismissible form appears in
 * the chat; from the 15th message without details the assistant stops answering and asks for
 * them, and answers again once they are given. The form (chat-panel) and the gate (actions)
 * read these. Client-safe.
 */
export const CHAT_CONTACT_ASK_AFTER = [5, 10] as const;
export const CHAT_CONTACT_REQUIRED_AFTER = 15;
