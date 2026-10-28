/*
 * Where the office is: the city through the glass. Shared by the scene (which
 * paints the skyline and follows the city's clock) and the chrome (the
 * location picker). Times come from the IANA zone, so daylight saving in
 * London, New York and Warsaw just works.
 */

export type CityId = "rio" | "dubai" | "london" | "new-york" | "tokyo" | "warsaw";

export interface City {
  id: CityId;
  name: string;
  country: string;
  /** IANA time zone. */
  tz: string;
  /** The wall clock's plate (the micro font is caps only, keep it short). */
  plate: string;
  /** What you see from the office, for the picker. */
  view: string;
}

export const CITIES: City[] = [
  { id: "rio", name: "Rio de Janeiro", country: "Brazil", tz: "America/Sao_Paulo", plate: "RIO", view: "Sugarloaf, Christ the Redeemer and the Copacabana promenade" },
  { id: "dubai", name: "Dubai", country: "UAE", tz: "Asia/Dubai", plate: "DUBAI", view: "The Burj Khalifa, Emirates Towers, the Museum of the Future and the Burj Al Arab" },
  { id: "london", name: "London", country: "UK", tz: "Europe/London", plate: "LONDON", view: "Big Ben, the London Eye, St Paul's and the Shard over the Thames" },
  { id: "new-york", name: "New York", country: "USA", tz: "America/New_York", plate: "NEW YORK", view: "Empire State, Chrysler, One World Trade and the Brooklyn Bridge" },
  { id: "tokyo", name: "Tokyo", country: "Japan", tz: "Asia/Tokyo", plate: "TOKYO", view: "Mount Fuji, the Skytree, Tokyo Tower and cherry trees in blossom" },
  { id: "warsaw", name: "Warsaw", country: "Poland", tz: "Europe/Warsaw", plate: "WARSAW", view: "The Palace of Culture, Varso, the Old Town's Royal Castle and the Vistula" },
];

export const DEFAULT_CITY: CityId = "rio";

export function cityOf(id: string | null | undefined): City {
  return CITIES.find((c) => c.id === id) ?? CITIES.find((c) => c.id === DEFAULT_CITY)!;
}

const formats = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, { at: number; ms: number }>();

/** How far the zone's wall clock is ahead of UTC at `ms`, re-read once a minute. */
export function tzOffsetMs(tz: string, ms = Date.now()): number {
  const have = offsets.get(tz);
  if (have && Math.abs(ms - have.at) < 60_000) return have.ms;
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  const off = wall - Math.floor(ms / 1000) * 1000;
  offsets.set(tz, { at: ms, ms: off });
  return off;
}

/** A Date whose UTC fields read the city's wall clock. */
export function cityDate(id: CityId, ms = Date.now()): Date {
  return new Date(ms + tzOffsetMs(cityOf(id).tz, ms));
}

/** The hour in the city, 0-24 with fractions. */
export function cityHour(id: CityId, ms = Date.now()): number {
  const d = cityDate(id, ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** "14:05" in the city. */
export function cityClock(id: CityId, ms = Date.now()): string {
  const d = cityDate(id, ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
