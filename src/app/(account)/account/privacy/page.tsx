import { DeleteAccountForm } from "@/components/account/profile-forms";
import { Button } from "@/components/ui/button";
import { requireCustomerPage } from "@/lib/auth/guards";
import { account } from "@/lib/i18n";

export const metadata = { title: account.nav.privacy };
export const instant = false;

const t = account.privacyPage;

/** Privacy (12 §2, 14 §3): download my data; delete my account. */
export default async function PrivacyPage() {
  await requireCustomerPage();
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <h1 className="text-h1">{t.title}</h1>
        <h2 className="text-h3">{t.download}</h2>
        <p className="text-text-muted">{t.downloadText}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline-site" size="md">
            <a href="/api/account/export" download>
              {t.download}
            </a>
          </Button>
          <Button asChild variant="outline-site" size="md">
            <a href="/api/account/export?format=pdf" download>
              {t.downloadPdf}
            </a>
          </Button>
        </div>
      </section>
      <section aria-labelledby="delete" className="flex flex-col gap-3">
        <h2 id="delete" className="text-h3 text-danger">
          {t.deleteTitle}
        </h2>
        <p className="max-w-xl text-text-muted">{t.deleteText}</p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}
