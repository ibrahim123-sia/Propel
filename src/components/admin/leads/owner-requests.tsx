"use client";

import { ExternalLinkIcon, HousePlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { OwnerRequestCard } from "@/features/valuation/admin";
import { createDraftFromListingRequest } from "@/features/valuation/admin-actions";
import { useAction } from "@/lib/use-action";

const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

/**
 * The owner's valuation and list-your-property requests on the lead page (11 §5-6): the home,
 * the estimate, photos, and one click to turn a listing request into a draft listing.
 */
export function OwnerRequests({
  items,
  readOnly,
}: {
  items: OwnerRequestCard[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const convert = useAction(createDraftFromListingRequest, {
    success: (d) => (d.created ? `Draft listing ${d.reference} created` : `Opening ${d.reference}`),
    onSuccess: (d) => router.push(`/admin/properties/${d.id}`),
  });
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="lead-owner-requests"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-4 py-2.5">
        <h2 id="lead-owner-requests" className="text-[13px] font-semibold text-ink">
          {items.length === 1
            ? items[0]!.kind === "valuation"
              ? "Valuation request"
              : "List your property"
            : "Owner requests"}
        </h2>
      </header>
      <ul className="flex flex-col divide-y divide-border text-[13px]">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 px-4 py-3">
            <p className="text-[12px] text-text-muted">
              {r.kind === "valuation" ? "Valuation" : "List your property"} ·{" "}
              {r.purpose === "rent" ? "Rent out" : "Sell"} · {day.format(new Date(r.createdAt))}
            </p>
            <p className="font-semibold text-ink">{r.home}</p>
            {r.kind === "valuation" && (
              <p className="text-ink">
                {r.estimate
                  ? `Estimate ${r.estimate} (${r.comparables} comparables)`
                  : "No estimate: fewer than 3 comparables"}
              </p>
            )}
            {r.askingPrice && <p className="text-ink">Asking {r.askingPrice}</p>}
            {r.availableFrom && <p className="text-ink">Available from {r.availableFrom}</p>}
            {(r.condition || r.upgrades.length > 0) && (
              <p className="text-text-muted">
                {[r.condition, ...r.upgrades].filter(Boolean).join(" · ")}
              </p>
            )}
            {r.notes && <p className="whitespace-pre-line text-text-muted">{r.notes}</p>}
            {r.photos.length > 0 && (
              <ul className="grid grid-cols-4 gap-1.5" aria-label="Photos from the owner">
                {r.photos.map((p, i) => (
                  <li key={p.id}>
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a small library thumbnail */}
                        <img
                          src={`${p.url}?w=128`}
                          alt={`Owner photo ${i + 1}`}
                          className="aspect-square w-full rounded object-cover"
                        />
                      </a>
                    ) : (
                      <span className="flex aspect-square items-center justify-center rounded bg-surface-muted text-[11px] text-text-muted">
                        {p.status}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {r.kind === "listing" &&
              (r.draft ? (
                <Link
                  href={`/admin/properties/${r.draft.id}`}
                  className="inline-flex items-center gap-1 font-semibold text-ink underline"
                >
                  Draft listing {r.draft.reference}
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                </Link>
              ) : (
                !readOnly && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={convert.pending}
                    onClick={() => void convert.run({ id: r.id })}
                  >
                    <HousePlusIcon aria-hidden /> Create draft listing
                  </Button>
                )
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
