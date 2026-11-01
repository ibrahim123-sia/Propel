"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { site } from "@/lib/i18n";
import { useLoadOnDemand } from "@/lib/use-load-on-demand";

// The menu (Radix menu and positioning) and the auth client load on the first click.
const loadDropdown = () => import("./account-dropdown").then((m) => m.AccountDropdown);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (
      (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
    ).toUpperCase() || "?"
  );
}

export function AccountMenuClient({
  name,
  email,
  isAdmin,
}: {
  name: string;
  email: string;
  isAdmin: boolean;
}) {
  const [Dropdown, loadMenu] = useLoadOnDemand(loadDropdown);
  const trigger = (
    <button
      type="button"
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={site.a11y.accountMenu}
      aria-haspopup="menu"
      onClick={Dropdown ? undefined : loadMenu}
    >
      <Avatar className="size-10">
        <AvatarFallback className="bg-ink text-[14px] font-semibold text-surface">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
    </button>
  );
  if (!Dropdown) return trigger;
  return <Dropdown trigger={trigger} name={name} email={email} isAdmin={isAdmin} />;
}
