"use client";

import type { Map as MapLibreMap, MapOptions } from "maplibre-gl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";

export type LngLat = { lng: number; lat: number };

/** The module object the lazy `import("./maplibre")` resolves to (only its type is static). */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- must match the dynamic import's type exactly
export type MapLibreModule = typeof import("./maplibre");

/**
 * MapLibre 6 builds its worker path from a variable, which bundlers cannot follow, so the
 * worker file is referenced here instead: the bundler emits it as a hashed static asset.
 */
const workerUrl = () =>
  new URL("../../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href;

/**
 * MapLibre map that loads its library only when it is about to be visible (14 §1: the map
 * loads when visible). `onReady` receives the map once its style has loaded.
 */
export function BaseMap({
  styleUrl,
  center,
  zoom,
  className,
  onReady,
  interactive = true,
  label = "Map",
  children,
  lazy = true,
  options,
}: {
  styleUrl: string;
  center: LngLat;
  zoom: number;
  className?: string;
  onReady?: (map: MapLibreMap, maplibre: MapLibreModule) => void;
  interactive?: boolean;
  label?: string;
  children?: ReactNode;
  lazy?: boolean;
  options?: Partial<MapOptions>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onReadyRef = useRef(onReady);
  const [visible, setVisible] = useState(!lazy);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    if (visible || !container.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(container.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !container.current || mapRef.current) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    import("./maplibre")
      .then((maplibre) => {
        if (cancelled || !container.current) return;
        if (!maplibre.getWorkerUrl()) maplibre.setWorkerUrl(workerUrl());
        map = new maplibre.Map({
          container: container.current,
          style: styleUrl,
          center: [center.lng, center.lat],
          zoom,
          interactive,
          attributionControl: { compact: true },
          cooperativeGestures: interactive ? matchMedia("(pointer: coarse)").matches : false,
          ...options,
        });
        mapRef.current = map;
        if (interactive)
          map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        map.on("error", (e) => console.warn("[map]", e.error?.message ?? e));
        map.once("load", () => onReadyRef.current?.(map!, maplibre));
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // The map is created once; later prop changes are applied by the owner through onReady.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <div className={cn("relative overflow-hidden bg-[#e8e4dc]", className)}>
      {/* h-full, not absolute: MapLibre gives its container position: relative. */}
      <div ref={container} className="h-full w-full" role="region" aria-label={label} />
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-[13px] text-text-muted">
          The map could not load. Check your connection.
        </p>
      )}
      {children}
    </div>
  );
}
