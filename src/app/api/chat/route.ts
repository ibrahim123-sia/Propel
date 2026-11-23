import { connection } from "next/server";
import { getDb } from "@/db/client";
import { parseVisitorCookie, VISITOR_COOKIE } from "@/features/attribution/visitor-cookie";
import { chatContactState, chatMessages, visitorChat } from "@/features/chat/store";
import { loadSettings } from "@/features/settings/queries";
import { currentAgencyId } from "@/db/schema/_common";
import { visitors } from "@/db/schema/crm";
import { and, eq } from "drizzle-orm";

const noStore = { "cache-control": "no-store" };

/** The website chat polls here (09 §1 #3): the visitor's open chat and its new messages. */
export async function GET(request: Request): Promise<Response> {
  try {
    await connection();
  } catch {
    // Outside a request (tests): nothing to opt out of.
  }
  const db = await getDb();
  if (!(await loadSettings("ai", db)).webChat.enabled)
    return Response.json(
      { enabled: false, conversation: null, messages: [] },
      { headers: noStore },
    );
  const cookie = request.headers.get("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === VISITOR_COOKIE)?.[1];
  const visitor = parseVisitorCookie(raw ? decodeURIComponent(raw) : null);
  if (!visitor)
    return Response.json({ enabled: true, conversation: null, messages: [] }, { headers: noStore });
  const [row] = await db
    .select({ id: visitors.id })
    .from(visitors)
    .where(and(eq(visitors.agencyId, currentAgencyId()), eq(visitors.visitorKey, visitor.key)));
  const conv = row ? await visitorChat(db, row.id) : null;
  if (!conv)
    return Response.json({ enabled: true, conversation: null, messages: [] }, { headers: noStore });
  const after = new URL(request.url).searchParams.get("after");
  const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
  // When to show the small details form, and whether the assistant waits for it.
  const contact = await chatContactState(db, conv);
  return Response.json(
    {
      enabled: true,
      conversation: { id: conv.id, status: conv.status, ...contact },
      messages: await chatMessages(db, conv.id, since),
    },
    { headers: noStore },
  );
}
