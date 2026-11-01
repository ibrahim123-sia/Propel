import type { SeedPreset } from "../types";
import { havenDune } from "./haven-dune";
import type { DemoPresetKey } from "./keys";
import { usDemo } from "./us-demo";

export { demoPresetKeys, isDemoPresetKey, otherPreset, type DemoPresetKey } from "./keys";

/** The demo presets (16 §1-2), by the key `pnpm db:seed --preset=` takes. */
export const demoPresets: Record<DemoPresetKey, SeedPreset> = {
  "haven-dune": havenDune,
  "us-demo": usDemo,
};
