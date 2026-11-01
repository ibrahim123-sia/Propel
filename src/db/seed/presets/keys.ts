/**
 * The demo presets' keys (16 §1-2), apart from their data, so app code (the System page, the
 * demo job) can name a preset without bundling every listing of it.
 */
export const demoPresetKeys = ["haven-dune", "us-demo"] as const;
export type DemoPresetKey = (typeof demoPresetKeys)[number];

export const isDemoPresetKey = (v: unknown): v is DemoPresetKey =>
  typeof v === "string" && (demoPresetKeys as readonly string[]).includes(v);

/** "Switch demo market" goes to the other one. */
export const otherPreset = (key: DemoPresetKey): DemoPresetKey =>
  key === "haven-dune" ? "us-demo" : "haven-dune";
