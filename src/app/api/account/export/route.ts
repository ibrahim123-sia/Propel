import { connection } from "next/server";
import { getDb } from "@/db/client";
import { loadEmailBrand } from "@/emails/brand";
import { customerDataHtml } from "@/features/account/export-pdf";
import { exportCustomerData, notifyDataExport } from "@/features/account/privacy";
import { loadSettings } from "@/features/settings/queries";
import { getCurrentUser } from "@/lib/auth/guards";
import { PdfUnavailableError, renderPdf } from "@/lib/pdf/render";

/**
 * "Download my data" (12 §2 Privacy): the signed-in customer's data as a JSON file, or as a
 * PDF with `?format=pdf`. Each download is confirmed by email (13 §1 "data export ready").
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  const user = await getCurrentUser();
  if (!user || user.role !== "customer") return new Response("Sign in first", { status: 401 });
  const db = await getDb();
  const data = await exportCustomerData(db, user.id);
  if (!data) return new Response("Not found", { status: 404 });
  const pdf = new URL(request.url).searchParams.get("format") === "pdf";

  let response: Response;
  if (pdf) {
    const [brand, general] = [await loadEmailBrand(db), await loadSettings("general", db)];
    try {
      const bytes = await renderPdf(
        customerDataHtml(data, brand, { timeZone: general.timeZone, generatedAt: new Date() }),
      );
      response = new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="my-data.pdf"',
          "cache-control": "private, no-store",
        },
      });
    } catch (err) {
      if (!(err instanceof PdfUnavailableError)) throw err;
      return new Response("The PDF could not be made right now. Download the JSON file instead.", {
        status: 503,
      });
    }
  } else {
    response = new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="my-data.json"',
        "cache-control": "private, no-store",
      },
    });
  }
  await notifyDataExport(db, user.id);
  return response;
}
