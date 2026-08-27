import { createServerFn } from "@tanstack/react-start";

/**
 * Google Maps Platform access (geocoding + Places API New) through the Lovable
 * connector gateway. Keys stay server-side; the browser only ever sees results.
 *
 * NOTHING here invents data: if Google returns no result, the caller gets an
 * empty list and the voice agent says so honestly.
 */

const GATEWAY = "https://connector-gateway.lovable.dev/google_maps";

function keys() {
  const lovable = process.env["LOVABLE_API_KEY"];
  const maps = process.env["GOOGLE_MAPS_API_KEY"];
  if (!lovable || !maps) throw new Error("Google Maps connector is not configured");
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": maps,
  } as Record<string, string>;
}

export interface GeoResult {
  text: string;
  latitude: number;
  longitude: number;
  /** Google location_type / result granularity, used to grade confidence. */
  precision: string;
  types: string[];
}

/** Geocode a free-text place description (village, temple, toll plaza, road…). */
export const geocodeQuery = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const d = data as { query?: string };
    const query = (d?.query ?? "").trim();
    if (!query) throw new Error("query required");
    return { query: query.slice(0, 200) };
  })
  .handler(async ({ data }): Promise<{ results: GeoResult[] }> => {
    const url =
      `${GATEWAY}/maps/api/geocode/json?address=${encodeURIComponent(data.query)}` +
      `&components=country:IN&bounds=15.60,72.60%7C22.10,80.90&region=in&language=en`;
    const res = await fetch(url, { headers: keys() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Geocoding failed [${res.status}]: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      status?: string;
      results?: {
        formatted_address?: string;
        types?: string[];
        geometry?: { location?: { lat: number; lng: number }; location_type?: string };
      }[];
    };
    if (json.status !== "OK" || !json.results?.length) return { results: [] };
    return {
      results: json.results.slice(0, 3).map((r) => ({
        text: r.formatted_address ?? data.query,
        latitude: r.geometry?.location?.lat ?? 0,
        longitude: r.geometry?.location?.lng ?? 0,
        precision: r.geometry?.location_type ?? "APPROXIMATE",
        types: r.types ?? [],
      })),
    };
  });

/**
 * Precise landmark lookup via Places API (New) text search.
 *
 * Geocoding often snaps a temple or chowk to the village centroid
 * (APPROXIMATE). Places searchText returns POI-level coordinates for named
 * landmarks like "Khandoba Mandir Nighoj", so callers' positions are far more
 * precise. Biased hard to the Maharashtra Wari corridor.
 */
export const placeLookup = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const d = data as { query?: string };
    const query = (d?.query ?? "").trim();
    if (!query) throw new Error("query required");
    return { query: query.slice(0, 160) };
  })
  .handler(async ({ data }): Promise<{ results: GeoResult[] }> => {
    const res = await fetch(`${GATEWAY}/places/v1/places:searchText`, {
      method: "POST",
      headers: {
        ...keys(),
        "Content-Type": "application/json",
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types",
      },
      body: JSON.stringify({
        textQuery: /maharashtra|india/i.test(data.query)
          ? data.query
          : `${data.query}, Maharashtra`,
        maxResultCount: 3,
        locationBias: {
          rectangle: {
            low: { latitude: 15.6, longitude: 72.6 },
            high: { latitude: 22.1, longitude: 80.9 },
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Place lookup failed [${res.status}]: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        primaryType?: string;
        types?: string[];
      }[];
    };
    return {
      results: (json.places ?? [])
        .filter((p) => p.location?.latitude != null && p.location?.longitude != null)
        .map((p) => ({
          text: p.formattedAddress || p.displayName?.text || data.query,
          latitude: p.location!.latitude!,
          longitude: p.location!.longitude!,
          // Places results are POI-level — treat like ROOFTOP precision.
          precision: "ROOFTOP",
          types: [p.primaryType, ...(p.types ?? [])].filter(Boolean) as string[],
        })),
    };
  });

export interface PlaceResult {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  primaryType: string;
  openNow: boolean | null;
  rating: number | null;
}

/** Nearby places search (Places API New) around real coordinates. */
export const nearbySearch = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const d = data as {
      latitude?: number;
      longitude?: number;
      includedTypes?: string[];
      textQuery?: string;
      radiusM?: number;
    };
    if (typeof d?.latitude !== "number" || typeof d?.longitude !== "number") {
      throw new Error("latitude and longitude required");
    }
    return {
      latitude: d.latitude,
      longitude: d.longitude,
      includedTypes: Array.isArray(d.includedTypes) ? d.includedTypes.slice(0, 5) : [],
      textQuery: (d.textQuery ?? "").slice(0, 120),
      radiusM: Math.min(Math.max(d.radiusM ?? 8000, 500), 50000),
    };
  })
  .handler(async ({ data }): Promise<{ places: PlaceResult[] }> => {
    const headers = {
      ...keys(),
      "Content-Type": "application/json",
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.currentOpeningHours.openNow,places.rating",
    };

    const map = (json: unknown): PlaceResult[] => {
      const j = json as {
        places?: {
          id?: string;
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
          primaryType?: string;
          currentOpeningHours?: { openNow?: boolean };
          rating?: number;
        }[];
      };
      return (j.places ?? [])
        .filter((p) => p.location?.latitude != null)
        .map((p) => ({
          id: p.id ?? "",
          name: p.displayName?.text ?? "Unnamed place",
          address: p.formattedAddress ?? "",
          latitude: p.location!.latitude!,
          longitude: p.location!.longitude!,
          primaryType: p.primaryType ?? "",
          openNow: p.currentOpeningHours?.openNow ?? null,
          rating: p.rating ?? null,
        }));
    };

    // 1. Structured nearby search on the place types for this category.
    if (data.includedTypes.length) {
      const res = await fetch(`${GATEWAY}/places/v1/places:searchNearby`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          includedTypes: data.includedTypes,
          maxResultCount: 10,
          rankPreference: "DISTANCE",
          locationRestriction: {
            circle: {
              center: { latitude: data.latitude, longitude: data.longitude },
              radius: data.radiusM,
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Places search failed [${res.status}]: ${body.slice(0, 200)}`);
      }
      const places = map(await res.json());
      if (places.length) return { places };
    }

    // 2. Fall back to a text search biased to the same circle.
    if (data.textQuery) {
      const res = await fetch(`${GATEWAY}/places/v1/places:searchText`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          textQuery: data.textQuery,
          maxResultCount: 10,
          locationBias: {
            circle: {
              center: { latitude: data.latitude, longitude: data.longitude },
              radius: data.radiusM,
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Places text search failed [${res.status}]: ${body.slice(0, 200)}`);
      }
      return { places: map(await res.json()) };
    }

    return { places: [] };
  });
