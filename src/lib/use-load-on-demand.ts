"use client";

import { useState, type ComponentType } from "react";

/**
 * A component downloaded the first time it is needed (a menu on its first click), not with
 * the page. Until it arrives the caller renders a look-alike placeholder, so nothing moves.
 * `load` must be a module-level function.
 */
export function useLoadOnDemand<P extends object>(load: () => Promise<ComponentType<P>>) {
  const [loaded, setLoaded] = useState<ComponentType<P> | null>(null);
  const request = () => {
    if (!loaded) void load().then((c) => setLoaded(() => c));
  };
  return [loaded, request] as const;
}
