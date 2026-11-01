import type { SeedPreset } from "../types";
import { havenDune } from "./haven-dune";
import { usDemo } from "./us-demo";

/** The demo presets (16 §1-2), by the key `pnpm db:seed --preset=` takes. */
export const demoPresetKeys = ["haven-dune", "us-demo"] as const;
export type DemoPresetKey = (typeof demoPresetKeys)[number];

export const demoPresets: Record<DemoPresetKey, SeedPreset> = {
  "haven-dune": havenDune,
  "us-demo": usDemo,
};

export const isDemoPresetKey = (v: unknown): v is DemoPresetKey =>
  typeof v === "string" && (demoPresetKeys as readonly string[]).includes(v);

/** "Switch demo market" goes to the other one. */
export const otherPreset = (key: DemoPresetKey): DemoPresetKey =>
  key === "haven-dune" ? "us-demo" : "haven-dune";
