import { z } from "zod";

/** The website chat (09 §1 #3). Client-safe. */
export const chatStartSchema = z.object({
  name: z.string().trim().max(80, "Use at most 80 characters").default(""),
  email: z.union([z.email("Enter a valid email address").max(160), z.literal("")]).default(""),
  phone: z.string().trim().max(30, "That number is too long").default(""),
  message: z.string().trim().min(1, "Write your message").max(2000, "Use at most 2,000 characters"),
  /** Honeypot: hidden from people, filled in by bots. */
  website: z.string().max(200).default(""),
  /** The page the chat was opened on (the assistant knows what the visitor is looking at). */
  page: z.string().max(500).default(""),
});
export type ChatStartInput = z.input<typeof chatStartSchema>;

/** The small form in the chat: a name and a phone or an email (checked by the action). */
export const chatContactSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80, "Use at most 80 characters"),
  email: z.union([z.email("Enter a valid email address").max(160), z.literal("")]).default(""),
  phone: z.string().trim().max(30, "That number is too long").default(""),
  website: z.string().max(200).default(""),
  page: z.string().max(500).default(""),
});
export type ChatContactInput = z.input<typeof chatContactSchema>;

export const chatMessageSchema = z.object({
  text: z.string().trim().min(1, "Write your message").max(2000, "Use at most 2,000 characters"),
  website: z.string().max(200).default(""),
  page: z.string().max(500).default(""),
});

export type ChatCard = {
  id: string;
  title: string;
  href: string;
  price: string;
  facts: string;
  photo: { url: string; alt: string } | null;
};

export type ChatMessage = {
  id: string;
  mine: boolean;
  sender: "customer" | "ai" | "admin" | "system";
  body: string;
  createdAt: string;
  /** Listings shown under an assistant message, loaded live (unpublished ones are left out). */
  cards: ChatCard[];
};
