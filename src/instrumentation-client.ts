/**
 * Runs in the browser before the app (Next's instrumentation-client convention).
 *
 * Zod probes for `eval` with `new Function("")` the first time it parses. The page CSP has no
 * 'unsafe-eval', so the probe is refused and reported as a violation (14 §2 wants none), even
 * though Zod catches it. `jitless` skips the probe. Zod keeps its config on this global
 * (zod/v4/core/core.js), so it is set here without loading Zod on every page.
 */
const zodConfig = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
zodConfig.__zod_globalConfig = { ...zodConfig.__zod_globalConfig, jitless: true };
