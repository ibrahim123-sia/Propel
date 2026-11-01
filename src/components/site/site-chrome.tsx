import type { ReactNode } from "react";
import { getSettings } from "@/features/settings/queries";
import { site } from "@/lib/i18n";
import { ChatLauncher } from "./chat/chat-launcher";
import { AnnouncementBar } from "./announcement-bar";
import { CookieBanner } from "./cookie-banner";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { SiteToaster } from "./site-toaster";
import { VisitorTracker } from "./visitor-tracker";
import { CompareTray } from "./account/compare-tray";
import { SiteStructuredData } from "./site-structured-data";

/**
 * Everything around a public page: skip link, announcement bar, header, footer,
 * notifications and the cookie banner. Used by the site layout and by the root 404 (which renders outside that layout).
 */
export async function SiteChrome({
  children,
  hideChat = false,
}: {
  children: ReactNode;
  /** The page's settings turn the chat button off (06 §2). */
  hideChat?: boolean;
}) {
  const legal = await getSettings("legal");
  const ai = await getSettings("ai");
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-ink px-4 py-2 text-surface focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        {site.a11y.skipToContent}
      </a>
      <SiteStructuredData />
      <AnnouncementBar />
      <SiteHeader />
      <main id="main" className="min-h-[60vh]">
        {children}
      </main>
      <SiteFooter />
      <SiteToaster />
      <VisitorTracker />
      <CompareTray />
      {ai.webChat.enabled && !hideChat && (
        <ChatLauncher
          title={ai.assistantName}
          greeting={ai.greeting}
          askContactFirst={ai.webChat.askContactFirst}
          humanButton={ai.showHumanButton}
        />
      )}
      <CookieBanner
        text={legal.cookieBanner.text}
        analyticsLabel={legal.cookieBanner.analyticsLabel}
        marketingLabel={legal.cookieBanner.marketingLabel}
      />
    </>
  );
}
