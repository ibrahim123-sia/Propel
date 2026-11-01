"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FormSection } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { switchDemoMarketAction } from "@/features/demo/actions";
import { useAction } from "@/lib/use-action";

const names = {
  "haven-dune": "Haven & Dune (AED, sq ft)",
  "us-demo": "Maple & Main (USD, sq ft, miles)",
};
type Preset = keyof typeof names;

/**
 * Demo builds only (16 §2-3): which market is loaded, when it was last reset, and "Switch demo
 * market". On a Node host the switch runs now (about a minute); on Cloudflare it happens in
 * the nightly reset.
 */
export function DemoPanel({
  preset,
  requested,
  lastResetAt,
  inPlace,
  readOnly,
}: {
  preset: Preset | null;
  requested: Preset | null;
  lastResetAt: string | null;
  inPlace: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const run = useAction(switchDemoMarketAction, {
    onSuccess: (r) => {
      toast.success(
        r.when === "now"
          ? `Switching to ${names[r.preset]}. The demo is reloaded in about a minute.`
          : `${names[r.preset]} loads at the next nightly reset.`,
      );
      router.refresh();
    },
  });
  const other: Preset = (requested ?? preset) === "us-demo" ? "haven-dune" : "us-demo";
  return (
    <FormSection
      title="Demo"
      description="The demo goes back to the seed every night. Switching the market reseeds with the other preset: only settings and data change."
    >
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Market loaded</dt>
          <dd className="font-medium">{preset ? names[preset] : "Not seeded yet"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last reset</dt>
          <dd className="font-medium">
            {lastResetAt ? new Date(lastResetAt).toLocaleString("en-GB") : "–"}
          </dd>
        </div>
        {requested && requested !== preset && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Next reset</dt>
            <dd className="font-medium">Switches to {names[requested]}</dd>
          </div>
        )}
      </dl>
      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={run.pending}
          onClick={() => void run.run({})}
        >
          Switch demo market to {names[other]}
        </Button>
      )}
      {!inPlace && (
        <p className="text-[12.5px] text-muted-foreground">
          On Cloudflare the reset runs in the nightly GitHub Action (Demo reset workflow).
        </p>
      )}
    </FormSection>
  );
}
