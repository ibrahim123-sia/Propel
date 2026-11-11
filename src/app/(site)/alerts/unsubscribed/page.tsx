import type { Metadata } from "next";

export const instant = false;
export const metadata: Metadata = { title: "Alerts", robots: { index: false } };

/** After the unsubscribe link in an alert email (12 §3). */
export default async function AlertsUnsubscribedPage(props: PageProps<"/alerts/unsubscribed">) {
  const sp = await props.searchParams;
  const search = typeof sp.search === "string" ? sp.search.slice(0, 120) : null;
  const kind = typeof sp.kind === "string" ? sp.kind : null;
  const message = search
    ? `You won't get alerts for “${search}” any more.`
    : kind === "newMatch"
      ? "You won't get emails about new homes any more."
      : kind === "priceDrop"
        ? "You won't get price drop emails for your saved homes any more."
        : kind === "statusChange"
          ? "You won't get emails when your saved homes are reserved, sold or rented."
          : "This link no longer works. You can manage your alerts in your account.";
  return (
    <div className="container-site flex max-w-xl flex-col gap-4 py-12">
      <h1 className="text-h2 text-ink">{kind === "invalid" ? "Alerts" : "Unsubscribed"}</h1>
      <p className="text-[16px] text-text">{message}</p>
      <p className="text-[15px] text-text-muted">
        <a
          href="/account/searches"
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          Manage your alerts
        </a>
        {" · "}
        <a href="/buy" className="underline-offset-4 hover:underline">
          Search homes
        </a>
      </p>
    </div>
  );
}
