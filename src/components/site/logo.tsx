import Image from "next/image";
import Link from "next/link";
import { cn } from "cn";
import type { PublicMedia } from "@/features/media/queries";

/** Agency logo from Settings -> General, or the agency name in the display font. */
export function Logo({
  agencyName,
  logo,
  className,
  inverted = false,
}: {
  agencyName: string;
  logo: PublicMedia | null;
  className?: string;
  inverted?: boolean;
}) {
  return (
    <Link
      href="/"
      className={cn("inline-flex items-center gap-2 rounded-md", className)}
      aria-label={`${agencyName}, home`}
    >
      {logo ? (
        <Image
          src={logo.url}
          alt=""
          width={logo.width ?? 160}
          height={logo.height ?? 40}
          className="h-9 w-auto"
          data-no-placeholder
          priority
          // Straight from /media: on Workers the optimizer fetches local sources from the
          // static assets, where media does not live, and answered 404. A logo is small.
          unoptimized
        />
      ) : (
        <span
          className={cn(
            "font-display text-[22px] leading-none tracking-tight",
            inverted ? "text-surface" : "text-ink",
          )}
        >
          {agencyName}
        </span>
      )}
    </Link>
  );
}
