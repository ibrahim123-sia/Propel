import type { DbOrTx } from "@/db/client";
import { loadSettings } from "@/features/settings/queries";
import { getSecret } from "@/features/settings/secrets";
import { recordIntegrationResult } from "@/features/system/alerts";
import { haversineMeters, type LngLat } from "@/lib/geo";

/**
 * Google Maps Platform behind an interface (13 §1): Geocoding, Places (nearby) and Routes.
 * Server key only, never sent to the browser. Called from admin actions and background jobs,
 * never on a public page view (07 §4.7). Tests swap the provider with `setMapsProvider`.
 */
export type PlaceResult = {
  googlePlaceId: string;
  name: string;
  address: string;
  point: LngLat;
  website: string | null;
};

export type RouteResult = {
  destinationIndex: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
};

export interface MapsProvider {
  geocode(query: string): Promise<{ point: LngLat; label: string } | null>;
  nearby(input: {
    type: string;
    center: LngLat;
    radiusM: number;
    max?: number;
  }): Promise<PlaceResult[]>;
  routes(input: {
    origin: LngLat;
    destinations: LngLat[];
    mode: "drive" | "walk";
  }): Promise<RouteResult[]>;
}

export class MapsNotConfiguredError extends Error {
  constructor() {
    super("Add a Google Maps server key in Settings -> Integrations to use this.");
    this.name = "MapsNotConfiguredError";
  }
}

let override: MapsProvider | null = null;
/** Tests and the demo build can inject a fake provider. */
export function setMapsProvider(provider: MapsProvider | null): void {
  override = provider;
}

export async function getMapsProvider(db?: DbOrTx): Promise<MapsProvider> {
  if (override) return override;
  const integrations = await loadSettings("integrations", db);
  const key = integrations.googleMaps.enabled
    ? await getSecret("google_maps_server_key", db)
    : null;
  if (!key) throw new MapsNotConfiguredError();
  return googleMaps(key);
}

export async function mapsConfigured(db?: DbOrTx): Promise<boolean> {
  if (override) return true;
  const integrations = await loadSettings("integrations", db);
  return integrations.googleMaps.enabled && Boolean(await getSecret("google_maps_server_key", db));
}

async function googleJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string };
    error_message?: string;
  };
  if (!res.ok)
    throw new Error(
      `Google Maps ${res.status}: ${body.error?.message ?? body.error_message ?? "request failed"}`,
    );
  return body;
}

export function googleMaps(key: string): MapsProvider {
  return {
    async geocode(query) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
      const body = await googleJson<{
        status: string;
        results: Array<{
          formatted_address: string;
          geometry: { location: { lat: number; lng: number } };
        }>;
      }>(url, {});
      const first = body.results?.[0];
      if (!first) return null;
      return {
        point: { lng: first.geometry.location.lng, lat: first.geometry.location.lat },
        label: first.formatted_address,
      };
    },

    async nearby({ type, center, radiusM, max = 20 }) {
      const body = await googleJson<{
        places?: Array<{
          id: string;
          displayName?: { text: string };
          formattedAddress?: string;
          location?: { latitude: number; longitude: number };
          websiteUri?: string;
        }>;
      }>("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri",
        },
        body: JSON.stringify({
          includedTypes: [type],
          maxResultCount: Math.min(20, max),
          rankPreference: "DISTANCE",
          locationRestriction: {
            circle: {
              center: { latitude: center.lat, longitude: center.lng },
              radius: Math.min(50_000, radiusM),
            },
          },
        }),
      });
      return (body.places ?? [])
        .filter((p) => p.location && p.displayName?.text)
        .map((p) => ({
          googlePlaceId: p.id,
          name: p.displayName!.text,
          address: p.formattedAddress ?? "",
          point: { lng: p.location!.longitude, lat: p.location!.latitude },
          website: p.websiteUri ?? null,
        }));
    },

    async routes({ origin, destinations, mode }) {
      if (destinations.length === 0) return [];
      const body = await googleJson<
        Array<{
          destinationIndex: number;
          distanceMeters?: number;
          duration?: string;
          condition?: string;
        }>
      >("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition",
        },
        body: JSON.stringify({
          origins: [
            { waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } },
          ],
          destinations: destinations.map((d) => ({
            waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
          })),
          travelMode: mode === "walk" ? "WALK" : "DRIVE",
        }),
      });
      return body.map((r) => ({
        destinationIndex: r.destinationIndex,
        distanceMeters: r.condition === "ROUTE_EXISTS" ? (r.distanceMeters ?? null) : null,
        durationSeconds:
          r.condition === "ROUTE_EXISTS" && r.duration
            ? Number.parseInt(r.duration.replace("s", ""), 10)
            : null,
      }));
    },
  };
}

/** "Test connection" in Settings -> Integrations: one cheap geocode; records the result. */
export async function testMapsConnection(db?: DbOrTx): Promise<{ ok: boolean; message: string }> {
  try {
    const provider = await getMapsProvider(db);
    const res = await provider.geocode("1600 Amphitheatre Parkway, Mountain View, CA");
    await recordIntegrationResult("google_maps_server_key", null, db);
    return {
      ok: Boolean(res),
      message: res ? "Connected" : "Key works, but the test address was not found",
    };
  } catch (err) {
    const message = (err as Error).message;
    if (!(err instanceof MapsNotConfiguredError))
      await recordIntegrationResult("google_maps_server_key", message, db);
    return { ok: false, message };
  }
}

/** Straight-line fallback when Routes is unavailable (07 §4.8). */
export function straightLineMeters(a: LngLat, b: LngLat): number {
  return haversineMeters(a, b);
}
