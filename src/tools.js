/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street. Used when the user does not share their
// location.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES = 10;
// Used only if the forecast payload has no area coordinates.
const DEFAULT_FORECAST_AREA = "Kallang";

// Places you can sit down or buy a meal at. Food courts and kopitiams are
// typed food_court or coffee_shop, not restaurant, so list them explicitly.
const EATING_TYPES = new Set([
  "restaurant",
  "food_court",
  "coffee_shop",
  "cafe",
  "meal_takeaway",
  "bakery",
]);

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat within walking distance of the user. Returns name, rating, distance from the user and whether it is open now.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the area the user is in.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07371".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 */
export async function executeTool(name, args, env, origin = CT_HUB_2) {
  // A failed lookup goes back to the model as an error result, so one
  // flaky API does not sink the whole reply.
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env, origin));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast(origin));
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    return JSON.stringify({ error: `${name} is not working right now` });
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env, origin) {
  const centre = origin;

  // locationBias only nudges results, so far-away matches still come back.
  // Text Search restricts by rectangle only, so use the box around the circle.
  const body = {
    textQuery: query,
    openNow: open_now,
    pageSize: MAX_PLACES,
    locationRestriction: {
      rectangle: boundingBox(centre, SEARCH_RADIUS_METRES),
    },
  };

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.rating,places.types,places.currentOpeningHours.openNow",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  return {
    places: formatPlaces(data.places ?? [], centre, SEARCH_RADIUS_METRES),
  };
}

/**
 * Shape Places API results into the fields Uncle needs, nearest first.
 * Drops places that are not somewhere to eat (malls, supermarkets) and
 * anything beyond maxMetres (the box corners reach past the circle).
 */
export function formatPlaces(places, origin, maxMetres = Infinity) {
  return places
    .filter(({ types = [] }) => types.some((t) => EATING_TYPES.has(t)))
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: rating ?? null,
      distance_m: Math.round(haversineMetres(origin, location)),
      open_now: currentOpeningHours?.openNow ?? null,
    }))
    .filter((place) => place.distance_m <= maxMetres)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Smallest lat/lng rectangle containing a circle, in Places API shape.
 */
export function boundingBox(centre, radiusMetres) {
  const dLat = radiusMetres / 111_320;
  const dLng = dLat / Math.cos((centre.latitude * Math.PI) / 180);
  return {
    low: { latitude: centre.latitude - dLat, longitude: centre.longitude - dLng },
    high: { latitude: centre.latitude + dLat, longitude: centre.longitude + dLng },
  };
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast(origin) {
  const res = await fetch(FORECAST_URL);
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  const payload = await res.json();
  const area =
    nearestArea(payload?.data?.area_metadata, origin) ?? DEFAULT_FORECAST_AREA;
  return formatForecast(payload, area);
}

/**
 * Name of the forecast area whose label point is closest to origin.
 */
export function nearestArea(areaMetadata, origin) {
  let best = null;
  let bestDistance = Infinity;
  for (const { name, label_location } of areaMetadata ?? []) {
    if (!label_location) continue;
    const distance = haversineMetres(origin, label_location);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f.area === area);
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code }) {
  if (!/^\d{5}$/.test(stop_code ?? "")) {
    return { error: "Bus stop code must be five digits" };
  }
  const url = `${BUS_URL}?id=${encodeURIComponent(stop_code)}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  return formatBusArrivals(await res.json(), stop_code);
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  // arrivelah reports an unknown stop as a 200 with an error field.
  if (payload?.error) {
    return { stop_code: stopCode, error: payload.error };
  }
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
