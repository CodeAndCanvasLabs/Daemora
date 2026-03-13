/**
 * googlePlaces - Search and get details from Google Places API.
 * Requires GOOGLE_PLACES_API_KEY env var.
 */
import { resolveKey } from "./_env.js";
import { mergeLegacyParams as _mergeLegacy } from "../utils/mergeToolParams.js";

export async function googlePlaces(_params) {
  const action = _params?.action;
  if (!action) return "Error: action required. Valid: search, details, nearby, autocomplete";
  const params = _mergeLegacy(_params);

  const apiKey = params.apiKey || resolveKey("GOOGLE_PLACES_API_KEY");
  if (!apiKey) return "Error: GOOGLE_PLACES_API_KEY env var required";

  const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
  const BASE = "https://maps.googleapis.com/maps/api";

  if (action === "search") {
    const { query, location, radius = 5000, type } = params;
    if (!query) return "Error: query is required";

    const qs = new URLSearchParams({
      query,
      key: apiKey,
      ...(location ? { location } : {}),
      ...(radius ? { radius: String(radius) } : {}),
      ...(type ? { type } : {}),
    });

    const res = await fetchFn(`${BASE}/place/textsearch/json?${qs}`);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return `Places API error: ${data.status} — ${data.error_message || ""}`;
    }
    if (!data.results?.length) return `No places found for "${query}"`;

    return data.results.slice(0, params.limit || 5).map(p => [
      `Name: ${p.name}`,
      `Address: ${p.formatted_address}`,
      `Rating: ${p.rating || "N/A"} (${p.user_ratings_total || 0} reviews)`,
      `Place ID: ${p.place_id}`,
      p.opening_hours?.open_now !== undefined ? `Open now: ${p.opening_hours.open_now}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
  }

  if (action === "details") {
    const { placeId, fields = "name,formatted_address,formatted_phone_number,website,rating,opening_hours,reviews" } = params;
    if (!placeId) return "Error: placeId is required";

    const qs = new URLSearchParams({ place_id: placeId, fields, key: apiKey });
    const res = await fetchFn(`${BASE}/place/details/json?${qs}`);
    const data = await res.json();
    if (data.status !== "OK") return `Places details error: ${data.status}`;

    const r = data.result;
    const lines = [
      `Name: ${r.name}`,
      `Address: ${r.formatted_address}`,
      r.formatted_phone_number ? `Phone: ${r.formatted_phone_number}` : null,
      r.website ? `Website: ${r.website}` : null,
      r.rating ? `Rating: ${r.rating}/5 (${r.user_ratings_total} reviews)` : null,
    ].filter(Boolean);

    if (r.opening_hours?.weekday_text) {
      lines.push("Hours:\n" + r.opening_hours.weekday_text.map(h => `  ${h}`).join("\n"));
    }

    if (r.reviews?.length && params.includeReviews) {
      lines.push("Top reviews:");
      r.reviews.slice(0, 3).forEach(rev => {
        lines.push(`  ⭐${rev.rating} — ${rev.author_name}: "${rev.text?.slice(0, 100)}..."`);
      });
    }

    return lines.join("\n");
  }

  if (action === "nearby") {
    const { location, radius = 1000, type } = params;
    if (!location) return "Error: location is required (e.g. '37.7749,-122.4194')";

    const qs = new URLSearchParams({
      location,
      radius: String(radius),
      key: apiKey,
      ...(type ? { type } : {}),
    });

    const res = await fetchFn(`${BASE}/place/nearbysearch/json?${qs}`);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return `Nearby search error: ${data.status}`;
    }
    if (!data.results?.length) return "No places found nearby";

    return data.results.slice(0, params.limit || 5).map(p =>
      `${p.name} — ${p.vicinity} (Rating: ${p.rating || "N/A"})`
    ).join("\n");
  }

  if (action === "autocomplete") {
    const { input, location, radius } = params;
    if (!input) return "Error: input is required";

    const qs = new URLSearchParams({
      input,
      key: apiKey,
      ...(location ? { location } : {}),
      ...(radius ? { radius: String(radius) } : {}),
    });

    const res = await fetchFn(`${BASE}/place/autocomplete/json?${qs}`);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return `Autocomplete error: ${data.status}`;
    }
    if (!data.predictions?.length) return `No suggestions for "${input}"`;

    return data.predictions.map(p => `${p.description} (${p.place_id})`).join("\n");
  }

  return `Unknown action: "${action}". Valid: search, details, nearby, autocomplete`;
}

export const googlePlacesDescription =
  `googlePlaces(action: string, paramsJson?: object) - Search places, get details, find nearby locations.
  action: "search" | "details" | "nearby" | "autocomplete"
  search params: { query, location?: "lat,lng", radius?: 5000, type?, limit?: 5 }
  details params: { placeId, fields?, includeReviews?: false }
  nearby params: { location: "lat,lng", radius?: 1000, type?, limit?: 5 }
  autocomplete params: { input, location?, radius? }
  Env var: GOOGLE_PLACES_API_KEY
  Examples:
    googlePlaces("search", {"query":"coffee shops in San Francisco"})
    googlePlaces("nearby", {"location":"37.7749,-122.4194","radius":500,"type":"restaurant"})
    googlePlaces("details", {"placeId":"ChIJN1t_tDeuEmsRUsoyG83frY4"})`;
