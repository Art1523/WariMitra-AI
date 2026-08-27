import { geocodeQuery, placeLookup, type GeoResult } from "@/lib/maps.functions";

/**
 * Natural spoken location → coordinates.
 *
 * The real Warkari may be on a feature phone with no GPS, so location comes
 * from speech only: a village, temple, toll plaza, bus stand, road, junction,
 * Dindi camp or a relative description ("we left Jejuri 30 minutes ago").
 *
 * Coordinates are NEVER invented — they come from Google geocoding through the
 * server function. When nothing resolves we return null and the agent asks a
 * better question.
 */

export type LocationConfidence = "high" | "medium" | "low";

export interface ResolvedLocation {
  /** What the caller effectively described, in a human readable form. */
  text: string;
  /** Exactly what the caller said. */
  spokenText: string;
  latitude: number;
  longitude: number;
  confidence: LocationConfidence;
  /** Set when the position was inferred from "N minutes after <village>". */
  relative?: {
    village: string;
    minutes: number;
    direction: "after" | "before";
    approxKm: number;
  };
  resolvedAt: string;
}

/** Typical Warkari walking speed (km/h) used for relative estimates. */
export const WALKING_KMPH = 4;

const DEVANAGARI_DIGITS: Record<string, string> = {
  "०": "0",
  "१": "1",
  "२": "2",
  "३": "3",
  "४": "4",
  "५": "5",
  "६": "6",
  "७": "7",
  "८": "8",
  "९": "9",
};

export function normalizeDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] ?? d);
}

const MINUTE_WORDS: Record<string, number> = {
  "अर्धा तास": 30,
  "अर्धा घंटा": 30,
  "एक तास": 60,
  "एक घंटा": 60,
  "दीड तास": 90,
  "पाच मिनिट": 5,
  "दहा मिनिट": 10,
  "पंधरा मिनिट": 15,
  "वीस मिनिट": 20,
  "पंचवीस मिनिट": 25,
  "तीस मिनिट": 30,
  "चाळीस मिनिट": 40,
  "half an hour": 30,
  "one hour": 60,
};

export function parseElapsedMinutes(text: string): number | null {
  const t = normalizeDigits(text.toLowerCase());
  const hours = t.match(/(\d{1,2})\s*(तास|घंटे|घंटा|hour|hr)/);
  if (hours) return Number(hours[1]) * 60;
  const mins = t.match(/(\d{1,3})\s*(मिनिट|मिनिटे|मिनट|minute|min)/);
  if (mins) return Number(mins[1]);
  for (const [word, m] of Object.entries(MINUTE_WORDS)) {
    if (t.includes(word)) return m;
  }
  return null;
}

/** "…सोडून" / "पुढे" / "नंतर" ⇒ after, "आधी" / "before" ⇒ before. */
function parseDirection(text: string): "after" | "before" {
  const t = text.toLowerCase();
  if (/(आधी|अगोदर|before|पूर्वी)/.test(t)) return "before";
  return "after";
}

/**
 * Pull the most likely place phrase out of a spoken sentence, dropping the
 * common Marathi/Hindi/English filler around it.
 */
export function extractPlacePhrase(spoken: string): string {
  let t = normalizeDigits(spoken);
  t = t
    .replace(
      /(मी|आम्ही|आहे|आहोत|जवळ|जवळच|इथे|येथे|आता|सध्या|कुठे|मला|माझ्या|आम्हाला|हो|नाही|सोडून|झाली|झाले|आहेत|गावाजवळ|च्या|ला|वर|मध्ये)/g,
      " ",
    )
    .replace(/\b(i|am|we|are|near|at|the|is|here|now|main|hoon|hun|ke|paas)\b/gi, " ")
    .replace(/\d{1,3}\s*(मिनिट|मिनिटे|मिनट|तास|घंटा|minutes?|hours?)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t;
}

function gradeConfidence(r: GeoResult): LocationConfidence {
  if (r.precision === "ROOFTOP" || r.precision === "RANGE_INTERPOLATED") return "high";
  if (
    r.types.some((t) =>
      ["premise", "point_of_interest", "establishment", "transit_station", "route"].includes(t),
    )
  ) {
    return "high";
  }
  if (r.types.includes("locality") || r.types.includes("sublocality")) return "medium";
  return "low";
}

async function geocode(query: string): Promise<GeoResult | null> {
  const q = query.trim();
  if (q.length < 3) return null;

  // 1. Places text search first — POI-level coordinates for named landmarks
  //    ("Khandoba Mandir Nighoj") where geocoding would only give the village
  //    centroid. This is what makes spoken locations precise.
  try {
    const places = await placeLookup({ data: { query: q } });
    const poi = places.results.find((r) =>
      r.types.some((t) =>
        [
          "hindu_temple",
          "place_of_worship",
          "tourist_attraction",
          "transit_station",
          "bus_station",
          "point_of_interest",
          "establishment",
          "premise",
        ].includes(t),
      ),
    );
    if (poi) return poi;
    if (places.results[0]) return places.results[0];
  } catch (err) {
    console.error("Place lookup error", err);
  }

  // 2. Fall back to classic geocoding for plain village/town names.
  try {
    const out = await geocodeQuery({
      data: { query: /maharashtra|india/i.test(q) ? q : `${q}, Maharashtra, India` },
    });
    return out.results[0] ?? null;
  } catch (err) {
    console.error("Geocoding error", err);
    return null;
  }
}

/**
 * Resolve whatever the caller said into a location.
 * Returns null when nothing usable could be geocoded.
 */
export async function resolveSpokenLocation(spoken: string): Promise<ResolvedLocation | null> {
  const phrase = extractPlacePhrase(spoken);
  if (!phrase) return null;

  const minutes = parseElapsedMinutes(spoken);
  const hit = await geocode(phrase);
  if (!hit || (!hit.latitude && !hit.longitude)) return null;

  const base: ResolvedLocation = {
    text: hit.text,
    spokenText: spoken.trim(),
    latitude: hit.latitude,
    longitude: hit.longitude,
    confidence: gradeConfidence(hit),
    resolvedAt: new Date().toISOString(),
  };

  if (minutes) {
    // Relative description: we know the anchor village but not the exact spot.
    const approxKm = Number(((minutes / 60) * WALKING_KMPH).toFixed(1));
    return {
      ...base,
      confidence: approxKm > 3 ? "low" : "medium",
      relative: {
        village: hit.text,
        minutes,
        direction: parseDirection(spoken),
        approxKm,
      },
    };
  }

  return base;
}

/** A short human label for panels and the dashboard. */
export function shortLocationLabel(loc: ResolvedLocation): string {
  const first = loc.text.split(",").slice(0, 2).join(",").trim();
  if (!loc.relative) return first;
  return `${loc.relative.approxKm} km ${loc.relative.direction} ${first}`;
}

export const locationService = {
  resolveSpokenLocation,
  parseElapsedMinutes,
  extractPlacePhrase,
  shortLocationLabel,
};
