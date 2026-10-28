/*
 * What you see through the glass: the office's city (web/cities.ts). A banded
 * sky that follows the clock in that city (night, dawn, day, dusk) for every
 * viewer, sun and moon, twinkling stars, drifting clouds, and parallax layers
 * of the city itself, far to near:
 *   Dubai: the Gulf with the Burj Al Arab's sail on it, the desert, a skyline
 *     of Emirates Towers and the Museum of the Future under the Burj Khalifa,
 *     and sand with palms in front. Some days a shamal blows sand across.
 *   Rio: the Atlantic, green granite peaks with Christ the Redeemer on
 *     Corcovado and Sugarloaf on the water, white blocks along the shore and
 *     the black-and-white waves of the Copacabana promenade.
 *   London: a hazy city, the cluster (the Shard, the Gherkin, the
 *     Walkie-Talkie, St Paul's dome), the riverbank (Elizabeth Tower and the
 *     London Eye) and the Thames. Some days it drizzles.
 *   New York: the Hudson, Midtown (Empire State, Chrysler, rooftop water
 *     tanks), One World Trade downtown and the Brooklyn Bridge over the river.
 *   Tokyo: Mount Fuji far off, the city with the Skytree rising out of it,
 *     Tokyo Tower in its red and white bands, and cherry trees in front.
 *   Warsaw: the Palace of Culture among Varso, Złota 44 and the Warsaw Spire,
 *     the Old Town's coloured houses with the Royal Castle and Sigismund's
 *     Column, and the Vistula. Some winter days it snows.
 * The weather is picked from the date in the city, so everyone's office has
 * the same weather today. Also exports the ambient darkness the lighting pass
 * uses for the room.
 */
import { C, mix, rgba } from "./palette.ts";
import { bitmap, clamp, hash, rng, type Bitmap } from "./util.ts";
import { DEFAULT_CITY, cityDate, type CityId } from "../cities.ts";

interface Key { h: number; top: string; mid: string; low: string; stars: number; lights: number; dark: number; haze: string }
const KEYS: Key[] = [
  { h: 0, top: "#070b1e", mid: "#101a38", low: "#22284e", stars: 1, lights: 1, dark: 0.68, haze: "#22284e" },
  { h: 4.8, top: "#0a0f28", mid: "#1a2148", low: "#2e2c5c", stars: 0.9, lights: 0.95, dark: 0.64, haze: "#2e2c5c" },
  { h: 5.8, top: "#2c3468", mid: "#a35c6e", low: "#f4a25e", stars: 0.15, lights: 0.6, dark: 0.36, haze: "#e0a070" },
  { h: 6.9, top: "#4a7cc0", mid: "#9cc2e2", low: "#f6d6a4", stars: 0, lights: 0.1, dark: 0.1, haze: "#e8d2ac" },
  { h: 10, top: "#3f86d6", mid: "#7dbbeb", low: "#e9e2cc", stars: 0, lights: 0, dark: 0, haze: "#e2d6bc" },
  { h: 15.5, top: "#4682cf", mid: "#86bde6", low: "#f0dfc0", stars: 0, lights: 0, dark: 0.02, haze: "#e8d4b0" },
  { h: 17.6, top: "#3d4f98", mid: "#d0707a", low: "#ffa552", stars: 0.05, lights: 0.4, dark: 0.24, haze: "#e09060" },
  { h: 18.7, top: "#1e2254", mid: "#5c3a6e", low: "#c8605a", stars: 0.5, lights: 0.85, dark: 0.44, haze: "#7a4a66" },
  { h: 19.8, top: "#0a0f28", mid: "#141c42", low: "#26285a", stars: 1, lights: 1, dark: 0.66, haze: "#26285a" },
  { h: 24, top: "#070b1e", mid: "#101a38", low: "#22284e", stars: 1, lights: 1, dark: 0.68, haze: "#22284e" },
];

export interface SkyState {
  hour: number;
  top: string;
  mid: string;
  low: string;
  haze: string;
  stars: number;
  lights: number;
  /** 0 = full daylight indoors, ~0.6 = night */
  dark: number;
  /** 0..1, how much sun comes through the windows */
  sun: number;
}

export function skyAt(hour: number): SkyState {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp((h - a.h) / (b.h - a.h), 0, 1);
  const s = t * t * (3 - 2 * t);
  const sun = clamp(Math.min((h - 6) / 1.4, (18.2 - h) / 1.4), 0, 1);
  return {
    hour: h,
    top: mix(a.top, b.top, s), mid: mix(a.mid, b.mid, s), low: mix(a.low, b.low, s), haze: mix(a.haze, b.haze, s),
    stars: a.stars + (b.stars - a.stars) * s,
    lights: a.lights + (b.lights - a.lights) * s,
    dark: a.dark + (b.dark - a.dark) * s,
    sun,
  };
}

export type Weather = "clear" | "dust" | "rain" | "snow";

/** Today's weather in the city, stable for the whole day there: a shamal in Dubai about one day in six, drizzle in London one in three, snow in Warsaw one winter day in three. */
export function weatherToday(city: CityId, ms = Date.now()): Weather {
  const d = cityDate(city, ms);
  const day = hash(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
  if (city === "dubai") return day % 6 === 0 ? "dust" : "clear";
  if (city === "london") return day % 3 === 0 ? "rain" : "clear";
  if (city === "warsaw") return (d.getUTCMonth() >= 10 || d.getUTCMonth() <= 2) && day % 3 === 0 ? "snow" : "clear";
  return "clear";
}

/** Bucketed so cached layers re-render only every few minutes of sky change. */
function bucket(h: number) {
  return Math.floor(h * 12);
}

const SAND = "#d9b47c", SAND_LIT = "#ecd09a", SAND_SHADE = "#b98f5a";
const GLASS = "#6f8fa8";
const SEA = "#38bdb6", SEA_NIGHT = "#0b2034";
/**
 * Rows up from the bottom of the view, near to far: where the city stands (CITY), the far edge of
 * the desert behind it (DESERT), and the sea's horizon beyond (HORIZON).
 */
const CITY = 10, DESERT = 20, HORIZON = 26;
const SAIL = "#f1efe9", SAIL_LIT = "#e8ecff", GOLD = "#e2b84a";
const PALM = "#3f7a3a", PALM_LT = "#5e9c46", TRUNK = "#7a5a3a";

const FOREST = "#3e6a3c", FOREST_LT = "#5a8a48", ROCK = "#6f7468", ROCK_LT = "#8d9184";
const STATUE = "#e9e6dc", STATUE_LIT = "#f6f3ff";
const RIO_WHITE = "#ece8dc", RIO_CREAM = "#e3d3ae", RIO_PINK = "#dcb0a4", RIO_BLUE = "#a8bccb", RIO_PAVE = "#9a8f7c", RIO_SAND = "#e6cc94";
const MOSAIC_WHITE = "#efece4", MOSAIC_BLACK = "#26252a";
const PORTLAND = "#cfc6b0", BRICK = "#8a5a48", GOTHIC = "#b5a37c";
const FUJI = "#5f7396", SKYTREE = "#d8e2ec", TOKYO_WHITE = "#e4e2dc", TOKYO_GREY = "#a9adb4", TOKYO_PATH = "#b9ad98";
const TOWER_RED = "#e2492f", TOWER_LIT = "#ff9a3c", SAKURA = "#f2b6c8", SAKURA_LT = "#ffd8e4", SAKURA_BARK = "#4a3530";
const PALACE = "#cdbf9f", PRL_GREY = "#9a9c98", ROOF = "#9a4a34", COPPER = "#5f9f86", CASTLE = "#c0704e", BRONZE = "#6f6a52";
const OLD_TOWN = ["#e2b04a", "#c8553d", "#7fa36a", "#d98f6f", "#e9dcc0", "#8fb0c8", "#d6a0a8"];
const NY_STONE = "#b9ac96", NY_BRICK = "#8e5e4c", STEEL_NY = "#b8c0c8", TANK = "#7a5a3a", BRIDGE_STONE = "#a89a80";

type G = CanvasRenderingContext2D;
const px = (g: G, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};

/** After dark enough for the city to light up. */
const night = (sky: SkyState) => sky.lights > 0.3;

/** A building colour seen through the sky: hazed by day, sinking into the night's blue after dark. */
function tone(c: string, sky: SkyState, k: number): string {
  return mix(mix(c, sky.haze, 0.3), mix(sky.mid, C.ink, 0.45), sky.lights * k);
}

/** Windows lit after dark on a block of the skyline. */
function windows(g: G, sky: SkyState, x: number, y: number, w: number, hh: number, dens: number) {
  const wr = rng(Math.floor(x * 131 + y));
  for (let wy = y + 2; wy < y + hh - 1; wy += 3) {
    for (let wx = x + 1; wx < x + w - 1; wx += 2) {
      const v = wr();
      if (v < dens * sky.lights) {
        g.globalAlpha = 0.55 + 0.45 * sky.lights;
        px(g, wx, wy, 1, 1, v < dens * 0.1 ? C.blue5 : v < dens * 0.4 ? C.gold4 : C.gold3);
        g.globalAlpha = 1;
      }
    }
  }
}

/** A plain block: its body, floor lines, a lit left edge and windows. */
function block(g: G, sky: SkyState, x: number, top: number, w: number, hh: number, body: string, dens: number) {
  px(g, x, top, w, hh, body);
  for (let y = top + 2; y < top + hh; y += 3) px(g, x, y, w, 1, mix(body, C.ink, 0.16));
  px(g, x, top, 1, hh, mix(body, sky.low, 0.3));
  windows(g, sky, x, top, w, hh, dens);
}

/** A row of palms, feet on `ground` (give or take), leaning this way and that. */
function palms(g: G, lw: number, ground: number, night: number, rr: () => number, gap: number) {
  const trunk = mix(TRUNK, C.ink, night * 0.7), leaf = mix(PALM, C.ink, night * 0.65), leafLt = mix(PALM_LT, C.ink, night * 0.65);
  let x = 6;
  while (x < lw) {
    const th = 11 + Math.floor(rr() * 5), lean = rr() < 0.5 ? -1 : 1, foot = ground - Math.floor(rr() * 3);
    for (let i = 0; i < th; i++) px(g, x + Math.round(lean * (i / th) ** 2 * 2), foot - i, 1, 1, trunk);
    const cx = x + lean * 2, cy = foot - th;
    for (const [dx, dy] of [[-1, 0], [1, 0], [-1, -0.6], [1, -0.6], [0, -1]] as const) {
      for (let s2 = 1; s2 <= 5; s2++) px(g, cx + Math.round(dx * s2), cy + Math.round(dy * s2 + (s2 * s2) / 7), 1, 1, s2 > 2 ? leafLt : leaf);
    }
    x += gap + Math.floor(rr() * 18);
  }
}

export class Sky {
  private layers: { bm: Bitmap; par: number }[] = [];
  private key = "";
  /** The city through the glass. */
  city: CityId = DEFAULT_CITY;
  private stars: { x: number; y: number; p: number; big: boolean }[] = [];
  private clouds: { x: number; y: number; w: number; s: number }[] = [];

  constructor(private seed = 7) {}

  /** Where the landmarks stand, in layer px (the layers start 80px left of the room). */
  private vista = { x: 0, w: 0 };

  private build(w: number, h: number, sky: SkyState, vista: { x: number; w: number }) {
    const key = `${this.city}|${w}x${h}|${bucket(sky.hour)}|${vista.x},${vista.w}`;
    if (key === this.key) return;
    this.key = key;
    this.vista = vista;
    const r = rng(this.seed);
    this.stars = [];
    for (let i = 0; i < (w * h) / 55; i++) this.stars.push({ x: r() * w, y: r() * h * 0.75, p: r() * 6.28, big: r() < 0.08 });
    this.clouds = [];
    // London has a lot more weather in its sky
    for (let i = 0; i < Math.ceil(w / (this.city === "london" ? 34 : 70)); i++) this.clouds.push({ x: r() * w, y: 3 + r() * h * 0.35, w: 10 + Math.floor(r() * 18), s: 0.6 + r() * 1.4 });
    const lw = w + 160;
    switch (this.city) {
      case "rio":
        this.layers = [
          { bm: this.gulf(lw, h, sky), par: 0.03 },
          { bm: this.rioPeaks(lw, h, sky), par: 0.05 },
          { bm: this.rioShore(lw, h, sky), par: 0.08 },
          { bm: this.copacabana(lw, h, sky), par: 0.16 },
        ];
        break;
      case "london":
        this.layers = [
          { bm: this.haze(lw, h, sky), par: 0.03 },
          { bm: this.londonCity(lw, h, sky), par: 0.06 },
          { bm: this.londonBank(lw, h, sky), par: 0.1 },
          { bm: this.river(lw, h, sky, "#5d6f6e"), par: 0.16 },
        ];
        break;
      case "new-york":
        this.layers = [
          { bm: this.haze(lw, h, sky), par: 0.03 },
          { bm: this.midtown(lw, h, sky), par: 0.06 },
          { bm: this.downtown(lw, h, sky), par: 0.09 },
          { bm: this.brooklynBridge(lw, h, sky), par: 0.16 },
        ];
        break;
      case "tokyo":
        this.layers = [
          { bm: this.fuji(lw, h, sky), par: 0.02 },
          { bm: this.tokyoCity(lw, h, sky), par: 0.06 },
          { bm: this.tokyoTower(lw, h, sky), par: 0.1 },
          { bm: this.sakura(lw, h, sky), par: 0.16 },
        ];
        break;
      case "warsaw":
        this.layers = [
          { bm: this.haze(lw, h, sky), par: 0.03 },
          { bm: this.warsawCity(lw, h, sky), par: 0.06 },
          { bm: this.oldTown(lw, h, sky), par: 0.1 },
          { bm: this.river(lw, h, sky, "#55707a"), par: 0.16 },
        ];
        break;
      case "dubai":
        this.layers = [
          { bm: this.gulf(lw, h, sky), par: 0.03 },
          { bm: this.desert(lw, h, sky), par: 0.05 },
          { bm: this.skyline(lw, h, sky), par: 0.08 },
          { bm: this.beach(lw, h, sky), par: 0.16 },
        ];
    }
  }

  /** Where a city's landmarks start: the vista's left edge (by the lift's core), kept inside the layer. */
  private anchor(lw: number, span: number) {
    const v = this.vista.w > 0 ? this.vista : { x: lw * 0.2, w: lw * 0.6 };
    return Math.round(clamp(v.x + 1, 4, lw - span));
  }

  /** Far out, behind the city: the open Gulf to the horizon, glittering with sun or city lights. */
  private gulf(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const rr = rng(hash("gulf") ^ this.seed);
    const top = h - HORIZON;
    const sea = mix(mix(SEA, sky.haze, 0.3), SEA_NIGHT, night * 0.9);
    px(g, 0, top, lw, h - top, sea);
    px(g, 0, top, lw, 1, mix(sea, sky.low, 0.45));
    for (let i = 0; i < lw / 3; i++) {
      const x = Math.floor(rr() * lw), y = top + 1 + Math.floor(rr() * (HORIZON - DESERT));
      g.globalAlpha = 0.5;
      px(g, x, y, 2, 1, night > 0.5 ? (rr() < 0.5 ? C.gold3 : C.gold4) : mix(C.white, sea, 0.3));
    }
    g.globalAlpha = 1;
    return bm;
  }

  /** Behind the city: open desert in low swells out to the sea, the Burj Al Arab's sail on the water beyond. */
  private desert(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const tint = (c: string) => mix(mix(c, sky.haze, 0.35), mix(sky.mid, C.ink, 0.35), night * 0.85);
    // the Burj Al Arab on its island, far out: a mast and a white sail bellying out to sea
    const arab = this.landmarks(lw).arab, base = h - HORIZON + 4;
    const sail = night > 0.3 ? mix(SAIL_LIT, C.blue5, 0.25) : mix(SAIL, sky.haze, 0.3), mast = mix(sail, C.ink, 0.25);
    const SH = 24;
    for (let i = 0; i < SH; i++) {
      const t = i / SH, belly = Math.round(Math.sin(Math.PI * (0.12 + t * 0.88)) * 6 * (1 - t * 0.3));
      px(g, arab, base - i, belly + 1, 1, i % 4 === 0 ? mix(sail, C.ink, 0.12) : sail);
    }
    px(g, arab - 1, base - SH - 3, 1, SH + 3, mast);
    px(g, arab + 3, base - 10, 4, 1, mast);
    px(g, arab - 3, base, 12, 2, tint(SAND_SHADE));
    if (night > 0.3) { g.globalAlpha = 0.5 * night; px(g, arab, base - SH + 2, 4, SH - 4, C.blue4); g.globalAlpha = 1; }
    let prev = h;
    for (let x = 0; x < lw; x++) {
      const y = Math.round(h - DESERT - 1.5 * Math.sin(x * 0.04 + this.seed) - Math.sin(x * 0.11 + 1.3));
      px(g, x, y, 1, 1, tint(y <= prev ? SAND_LIT : SAND_SHADE));
      px(g, x, y + 1, 1, h - y - 1, tint(SAND));
      prev = y;
    }
    return bm;
  }

  /** The city on the sand: glass and stone towers around Emirates Towers, the Museum of the Future and the Burj Khalifa over them all. */
  private skyline(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - CITY;
    const glass = mix(mix(GLASS, sky.haze, 0.3), mix(sky.mid, C.ink, 0.45), sky.lights * 0.8);
    const edge = mix(glass, sky.low, 0.3);
    // some towers are sand-coloured stone instead of glass
    const stone = mix(mix(SAND_SHADE, sky.haze, 0.25), mix(sky.mid, C.ink, 0.45), sky.lights * 0.8);
    const steel = tone(STEEL_NY, sky, 0.55);
    const rr = rng(hash("skyline") ^ this.seed);
    const { emirates, museum, burj, arab } = this.landmarks(lw);
    // no tower in front of the Burj Al Arab out on the water either
    const taken: [number, number][] = [[arab - 4, arab + 10], [emirates - 2, emirates + 16], [museum - 2, museum + 17], [burj - 9, burj + 10]];
    let x = -4;
    while (x < lw) {
      const w = 6 + Math.floor(rr() * 9);
      const th = Math.floor(h * (0.22 + rr() * 0.3));
      if (!taken.some(([a, b]) => x + w > a && x < b)) {
        block(g, sky, x, ground - th, w, th + 8, rr() < 0.3 ? stone : glass, 0.45);
        if (rr() < 0.3) px(g, x + Math.floor(w / 2), ground - th - 4, 1, 4, glass);
      }
      x += w + 3 + Math.floor(rr() * 6);
    }
    // Emirates Towers: a tall and a shorter twin, each cut off at a slant
    const wedge = (x0: number, w: number, th: number) => {
      for (let c = 0; c < w; c++) {
        const top = ground - th + Math.round((c / w) * 6);
        px(g, x0 + c, top, 1, th + 8 - (top - (ground - th)), c === 0 ? edge : c === w - 1 ? mix(glass, C.ink, 0.2) : steel);
      }
      for (let y = ground - th + 8; y < ground; y += 3) px(g, x0 + 1, y, w - 2, 1, mix(steel, C.ink, 0.18));
      windows(g, sky, x0, ground - th + 6, w, th - 6, 0.35);
      px(g, x0, ground - th - 4, 1, 4, edge);
    };
    wedge(emirates, 7, 38);
    wedge(emirates + 9, 6, 32);
    // the Museum of the Future: a silver ring standing on a green mound, the hole in the middle
    const RX = 7, RY = 8, mcx = museum + 8, mcy = ground - 10;
    for (let yy = -RY; yy <= RY; yy++) for (let xx = -RX; xx <= RX; xx++) {
      const d = (xx * xx) / (RX * RX) + (yy * yy) / (RY * RY);
      const hole = ((xx + 1) * (xx + 1)) / 9 + (yy * yy) / 20;
      if (d > 1 || hole < 1) continue;
      const lace = (xx * 3 + yy * 5 + 40) % 7 === 0;
      px(g, mcx + xx, mcy + yy, 1, 1, lace ? mix(steel, C.ink, 0.4) : xx > 3 ? mix(steel, C.ink, 0.15) : steel);
    }
    if (sky.lights > 0.3) { g.globalAlpha = 0.6 * sky.lights; for (let a = 0; a < 40; a++) { const t = (a / 40) * Math.PI * 2; px(g, Math.round(mcx + Math.cos(t) * RX), Math.round(mcy + Math.sin(t) * RY), 1, 1, C.gold4); } g.globalAlpha = 1; }
    px(g, museum, ground - 2, 17, 2, tone(FOREST, sky, 0.7));
    // the Burj Khalifa: setbacks stepping in on alternate sides, up to a needle spire above everything
    const tiers: [number, number, number][] = [[9, 6, 6], [17, 5, 6], [24, 5, 4], [31, 3, 4], [37, 3, 2], [42, 2, 2], [46, 1, 2], [50, 1, 1]];
    let from = 0;
    for (const [to, l, r] of tiers) {
      for (let i = from; i < to; i++) {
        px(g, burj - l, ground - i, l + r + 1, 1, i % 3 === 0 ? mix(glass, C.ink, 0.12) : glass);
        px(g, burj - l, ground - i, 1, 1, edge);
        px(g, burj + r, ground - i, 1, 1, mix(glass, C.ink, 0.25));
      }
      from = to;
    }
    windows(g, sky, burj - 4, ground - 46, 9, 46, 0.55);
    px(g, burj, ground - 62, 1, 12, edge);
    if (sky.lights > 0.3) {
      // LED strips up the setbacks and the warning light on the tip
      g.globalAlpha = 0.7 * sky.lights;
      for (const [to, l, r] of tiers) { px(g, burj - l, ground - to, 1, 1, C.white); px(g, burj + r, ground - to, 1, 1, C.white); }
      px(g, burj, ground - 62, 1, 1, C.red3);
      g.globalAlpha = 1;
    }
    // the sand the city stands on, running out to the beach
    const land = mix(mix(SAND_SHADE, sky.haze, 0.2), mix(sky.mid, C.ink, 0.4), sky.lights * 0.85);
    px(g, 0, ground, lw, h - ground, land);
    px(g, 0, ground, lw, 1, mix(land, sky.low, 0.3));
    return bm;
  }

  /**
   * The Burj Khalifa stands in the middle of the clear glass between the lift and the TV, so it
   * shows however narrow that is. Emirates Towers go right of it; the Museum of the Future and the
   * Burj Al Arab (far out on the water) go left when there is room, else on to the right, where a
   * narrow vista lets them run on behind the TV.
   */
  private landmarks(lw: number) {
    const v = this.vista.w > 0 ? this.vista : { x: lw * 0.2, w: lw * 0.6 };
    const burj = Math.round(clamp(v.x + Math.max(10, v.w / 2), 14, lw - 80));
    const room = burj - 9 - v.x;
    const museum = room >= 40 ? burj - 28 : burj + 28;
    const arab = room >= 40 ? Math.max(v.x + 2, museum - 14) : room >= 16 ? v.x + 3 : burj + 50;
    return { arab, emirates: burj + 10, museum, burj };
  }

  /** In front: the sand right under the tower, in soft swells, with palms on it. */
  private beach(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const rr = rng(hash("beach") ^ this.seed);
    // the sand, rising in soft swells toward the glass
    const sand = mix(mix(SAND, sky.haze, 0.05), mix(sky.mid, C.ink, 0.4), night * 0.85);
    const sandLit = mix(mix(SAND_LIT, sky.haze, 0.05), mix(sky.mid, C.ink, 0.3), night * 0.85);
    for (let x = 0; x < lw; x++) {
      const y = Math.round(h - 6 - 1.5 * Math.sin(x * 0.05 + this.seed) - Math.sin(x * 0.13));
      px(g, x, y, 1, 2, sandLit);
      px(g, x, y + 2, 1, h - y - 2, sand);
    }
    for (let i = 0; i < lw / 4; i++) px(g, Math.floor(rr() * lw), h - 1 - Math.floor(rr() * 5), 1, 1, sandLit);
    palms(g, lw, h - 2, night, rr, 16);
    return bm;
  }

  /* ------------------------------------------------------------------ Rio */

  /** Green granite peaks behind the shore: Corcovado with Christ the Redeemer, Sugarloaf rising from the water. */
  private rioPeaks(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const tint = (c: string, k = 0.3) => mix(mix(c, sky.haze, k), mix(sky.mid, C.ink, 0.5), night * 0.85);
    const forest = tint(FOREST), forestLt = tint(FOREST_LT), rock = tint(ROCK), rockLt = tint(ROCK_LT, 0.2);
    const base = h - CITY + 2;
    const a = this.anchor(lw, 150);
    const corc = a + 18, sugar = a + 92, urca = a + 74;
    // the ridge behind everything: rolling forested hills, rising to Corcovado's needle
    const ridge = (x: number) => {
      const roll = 13 + 4 * Math.sin(x * 0.045 + this.seed) + 3 * Math.sin(x * 0.11 + 2);
      // a steep granite needle with a rounded top, not a pyramid
      const d = Math.abs(x - corc);
      const peak = d < 4 ? 44 - d * d * 0.35 : Math.max(0, 44 - 5.6 - (d - 4) * 1.9 + Math.max(0, 14 - d) * 0.25);
      return Math.max(roll, peak);
    };
    let prev = ridge(0);
    for (let x = 0; x < lw; x++) {
      const top = Math.round(base - ridge(x));
      const steep = Math.abs(ridge(x) - prev) > 0.9;
      prev = ridge(x);
      px(g, x, top, 1, base - top + 2, forest);
      // bare granite on the steep faces, forest on the gentle ones
      if (steep) px(g, x, top, 1, Math.min(10, base - top), x < corc ? rockLt : rock);
      else px(g, x, top, 1, 1, forestLt);
    }
    // Sugarloaf and Morro da Urca: bare rounded domes standing in the bay
    const dome = (cx: number, R: number, H: number) => {
      for (let dx = -R; dx <= R; dx++) {
        const t = dx / R, top = Math.round(base - H * Math.sqrt(Math.max(0, 1 - t * t * t * t)));
        px(g, cx + dx, top, 1, base - top + 2, dx < -R * 0.3 ? rockLt : rock);
        if (dx > R * 0.4) px(g, cx + dx, top + 3, 1, base - top - 3, forest);
      }
    };
    dome(urca, 9, 13);
    dome(sugar, 8, 30);
    // the cable car: a thin line from Urca to the top of Sugarloaf, a car on it
    g.globalAlpha = 0.6;
    for (let i = 0; i <= 18; i++) px(g, urca + 4 + i, Math.round(base - 13 - (i / 18) * 17), 1, 1, tint(C.slate2, 0.1));
    g.globalAlpha = 1;
    px(g, urca + 13, Math.round(base - 13 - 0.5 * 17) + 1, 2, 2, tint(C.terra4, 0.1));
    // Christ the Redeemer on the needle: arms wide, floodlit white after dark
    const top = Math.round(base - ridge(corc));
    const statue = night > 0.3 ? STATUE_LIT : mix(STATUE, sky.haze, 0.2);
    if (night > 0.3) {
      const halo = g.createRadialGradient(corc, top - 6, 1, corc, top - 6, 12);
      halo.addColorStop(0, rgba(STATUE_LIT, 0.45 * night));
      halo.addColorStop(1, rgba(STATUE_LIT, 0));
      g.fillStyle = halo;
      g.fillRect(corc - 12, top - 18, 24, 24);
    }
    px(g, corc - 1, top - 2, 3, 2, statue);
    px(g, corc - 1, top - 9, 2, 7, statue);
    px(g, corc - 5, top - 8, 10, 1, statue);
    px(g, corc - 1, top - 11, 2, 2, statue);
    return bm;
  }

  /** The shore: white and pastel apartment blocks packed along the beach, windows lit after dark. */
  private rioShore(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - CITY + 4;
    const rr = rng(hash("rio") ^ this.seed);
    const paints = [RIO_WHITE, RIO_CREAM, RIO_PINK, RIO_BLUE].map((c) => tone(c, sky, 0.75));
    let x = -3;
    while (x < lw) {
      const w = 5 + Math.floor(rr() * 8);
      const th = Math.floor(h * (0.1 + rr() * 0.2));
      block(g, sky, x, ground - th, w, th + 6, paints[Math.floor(rr() * paints.length)]!, 0.55);
      x += w + 1 + Math.floor(rr() * 2);
    }
    const land = tone(RIO_PAVE, sky, 0.85);
    px(g, 0, ground, lw, h - ground, land);
    return bm;
  }

  /** In front: Copacabana's sand, palms, and the black-and-white wave mosaic of the promenade. */
  private copacabana(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const sand = mix(mix(RIO_SAND, sky.haze, 0.05), mix(sky.mid, C.ink, 0.4), night * 0.85);
    const sandLit = mix(mix(SAND_LIT, sky.haze, 0.05), mix(sky.mid, C.ink, 0.3), night * 0.85);
    for (let x = 0; x < lw; x++) {
      const y = Math.round(h - 7 - Math.sin(x * 0.05 + this.seed));
      px(g, x, y, 1, 1, sandLit);
      px(g, x, y + 1, 1, h - y - 1, sand);
    }
    // the calçadão: black waves on white stone along the bottom
    const white = mix(MOSAIC_WHITE, C.ink, night * 0.6), black = mix(MOSAIC_BLACK, C.ink, night * 0.4);
    px(g, 0, h - 4, lw, 4, white);
    for (let x = 0; x < lw; x++) {
      const y = h - 3 + Math.round(Math.sin(x * 0.55));
      px(g, x, y, 1, 1, black);
    }
    palms(g, lw, h - 5, night, rng(hash("copa") ^ this.seed), 22);
    return bm;
  }

  /* --------------------------------------------------------------- London */

  /** The far city in the mist: low blocks fading into the haze, a few lights after dark. */
  private haze(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const rr = rng(hash("haze") ^ this.seed);
    const body = mix(tone(GLASS, sky, 0.8), sky.haze, 0.45);
    const ground = h - CITY;
    let x = 0;
    while (x < lw) {
      const w = 4 + Math.floor(rr() * 8), th = Math.floor(h * (0.08 + rr() * 0.22));
      px(g, x, ground - th, w, th + CITY, body);
      if (sky.lights > 0.3) {
        g.globalAlpha = 0.4 * sky.lights;
        for (let i = 0; i < w * th * 0.05; i++) px(g, x + Math.floor(rr() * w), ground - th + 1 + Math.floor(rr() * th), 1, 1, C.gold3);
        g.globalAlpha = 1;
      }
      x += w + Math.floor(rr() * 3);
    }
    return bm;
  }

  /** The City and the South Bank: the Shard, the Gherkin, the Walkie-Talkie and St Paul's dome over brick and stone. */
  private londonCity(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - CITY + 2;
    const glass = tone(GLASS, sky, 0.8), stone = tone(PORTLAND, sky, 0.8), brick = tone(BRICK, sky, 0.8);
    const a = this.anchor(lw, 160);
    const pauls = a + 44, gherkin = a + 70, walkie = a + 84, shard = a + 112;
    const taken: [number, number][] = [[pauls - 2, pauls + 20], [gherkin - 2, gherkin + 11], [walkie - 2, walkie + 13], [shard - 10, shard + 12]];
    const rr = rng(hash("london") ^ this.seed);
    let x = -3;
    while (x < lw) {
      const w = 5 + Math.floor(rr() * 8), th = Math.floor(h * (0.12 + rr() * 0.22));
      if (!taken.some(([l, r]) => x + w > l && x < r)) block(g, sky, x, ground - th, w, th + 6, rr() < 0.35 ? glass : rr() < 0.5 ? brick : stone, 0.4);
      x += w + 1 + Math.floor(rr() * 3);
    }
    const lit = sky.lights;
    const edge = mix(glass, sky.low, 0.35);
    // St Paul's: a stone drum, the great dome, its lantern and a gold cross
    px(g, pauls, ground - 10, 18, 10, stone);
    px(g, pauls + 3, ground - 14, 12, 4, stone);
    for (let c = pauls + 4; c < pauls + 14; c += 2) px(g, c, ground - 13, 1, 3, mix(stone, C.ink, 0.25));
    for (let dy = 0; dy <= 7; dy++) {
      const hw = Math.round(Math.sqrt(49 - dy * dy));
      px(g, pauls + 9 - hw, ground - 14 - dy, hw * 2, 1, dy > 5 ? mix(stone, C.white, 0.2) : stone);
      px(g, pauls + 9 + hw - 2, ground - 14 - dy, 2, 1, mix(stone, C.ink, 0.2));
    }
    px(g, pauls + 8, ground - 25, 2, 4, stone);
    px(g, pauls + 8, ground - 28, 2, 3, GOLD);
    px(g, pauls + 7, ground - 27, 4, 1, GOLD);
    if (lit > 0.3) { g.globalAlpha = 0.35 * lit; px(g, pauls + 3, ground - 21, 12, 7, STATUE_LIT); g.globalAlpha = 1; }
    // the Gherkin: a rounded bullet with a dark diagrid spiral
    const GH = 30;
    for (let i = 0; i < GH; i++) {
      const t = i / GH, hw = Math.max(1, Math.round(4.5 * Math.sin(Math.PI * (0.18 + t * 0.82)) + (t < 0.5 ? 0.5 : 0)));
      for (let c = -hw; c < hw; c++) px(g, gherkin + 4 + c, ground - i, 1, 1, (c + i * 2 + 40) % 5 === 0 ? mix(glass, C.ink, 0.35) : c === -hw ? edge : glass);
    }
    windows(g, sky, gherkin + 2, ground - GH + 6, 5, GH - 8, 0.3);
    // the Walkie-Talkie: wider at the top than the bottom
    const WH = 28;
    for (let i = 0; i < WH; i++) {
      const hw = 4 + Math.round((i / WH) ** 2 * 3);
      px(g, walkie + 5 - hw, ground - i, hw * 2, 1, i % 3 === 0 ? mix(glass, C.ink, 0.15) : glass);
    }
    px(g, walkie - 2, ground - WH, 14, 1, edge);
    windows(g, sky, walkie + 1, ground - WH + 2, 9, WH - 3, 0.35);
    // the Shard: a tall glass pyramid splintering at the tip
    const SH = 50;
    for (let i = 0; i < SH; i++) {
      const hw = Math.max(0, Math.round(9 * (1 - i / SH)));
      if (hw === 0 && i % 2) continue;
      px(g, shard - hw, ground - i, hw * 2 + 1, 1, glass);
      px(g, shard - hw, ground - i, 1, 1, edge);
      px(g, shard + 1, ground - i, Math.max(0, hw - 1), 1, mix(glass, sky.low, 0.15));
    }
    px(g, shard - 1, ground - SH - 2, 1, 3, edge);
    px(g, shard + 1, ground - SH - 1, 1, 2, edge);
    windows(g, sky, shard - 5, ground - 30, 10, 28, 0.3);
    if (lit > 0.4) { g.globalAlpha = 0.8 * lit; px(g, shard, ground - SH + 2, 1, 4, C.white); g.globalAlpha = 1; }
    px(g, 0, ground, lw, h - ground, tone(BRICK, sky, 0.85));
    return bm;
  }

  /** The riverbank: the Palace of Westminster with Elizabeth Tower, and the London Eye turning slowly. */
  private londonBank(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 8;
    const lit = sky.lights;
    const stone = tone(GOTHIC, sky, 0.75), shade = mix(stone, C.ink, 0.3);
    const a = this.anchor(lw, 150);
    const ben = a + 8, eye = a + 62;
    // the Houses of Parliament: a long gothic front, pinnacles on top
    px(g, ben + 4, ground - 9, 40, 9, stone);
    for (let x = ben + 5; x < ben + 44; x += 3) { px(g, x, ground - 11, 1, 2, stone); px(g, x + 1, ground - 7, 1, 4, shade); }
    if (lit > 0.3) { g.globalAlpha = 0.5 * lit; for (let x = ben + 6; x < ben + 43; x += 3) px(g, x, ground - 6, 1, 2, C.gold3); g.globalAlpha = 1; }
    // Elizabeth Tower: a tall square tower, the clock face, the belfry and the spire
    const BT = 40;
    px(g, ben, ground - BT, 6, BT, stone);
    px(g, ben + 5, ground - BT, 1, BT, shade);
    for (let y = ground - BT + 14; y < ground; y += 3) px(g, ben + 1, y, 4, 1, shade);
    px(g, ben - 1, ground - BT + 6, 8, 7, stone);
    px(g, ben, ground - BT + 7, 6, 5, lit > 0.3 ? C.gold4 : mix(C.white, sky.haze, 0.3));
    px(g, ben + 3, ground - BT + 8, 1, 2, C.ink); px(g, ben + 3, ground - BT + 9, 2, 1, C.ink);
    px(g, ben, ground - BT + 3, 6, 3, shade);
    for (let i = 0; i < 9; i++) { const hw = Math.max(0, Math.round(3 - i / 3)); px(g, ben + 3 - hw, ground - BT + 2 - i, hw * 2 || 1, 1, i > 6 ? GOLD : stone); }
    // the London Eye: the rim, spokes to the hub, the legs, capsules round the rim
    const R = 18, cx = eye + R, cy = ground - R - 3;
    const rim = lit > 0.3 ? mix(C.blue4, C.pink, 0.3) : mix(C.white, sky.haze, 0.25);
    const spoke = mix(rim, sky.mid, 0.55);
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      for (let r = 2; r < R; r += 2) px(g, Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), 1, 1, spoke);
    }
    for (let i = 0; i < 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      px(g, Math.round(cx + Math.cos(t) * R), Math.round(cy + Math.sin(t) * R), 1, 1, rim);
    }
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      px(g, Math.round(cx + Math.cos(t) * (R + 1)), Math.round(cy + Math.sin(t) * (R + 1)), 1, 1, lit > 0.3 ? C.white : mix(C.slate4, sky.haze, 0.3));
    }
    px(g, cx - 1, cy - 1, 3, 3, rim);
    for (let i = 0; i < R + 3; i++) { px(g, cx - Math.round(i * 0.35), cy + i, 1, 1, shade); px(g, cx + Math.round(i * 0.12), cy + i, 1, 1, shade); }
    return bm;
  }

  /** In front: a river (the Thames, the East River) with the embankment wall and the city's lights glinting on it. */
  private river(lw: number, h: number, sky: SkyState, water: string): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const top = h - 8;
    const w0 = mix(mix(water, sky.mid, 0.35), SEA_NIGHT, night * 0.85);
    px(g, 0, top, lw, h - top, w0);
    px(g, 0, top, lw, 1, mix(w0, sky.low, 0.5));
    const rr = rng(hash("river") ^ this.seed);
    for (let i = 0; i < lw / 2; i++) {
      g.globalAlpha = 0.5;
      px(g, Math.floor(rr() * lw), top + 1 + Math.floor(rr() * 5), 2 + Math.floor(rr() * 3), 1, night > 0.5 ? (rr() < 0.5 ? C.gold3 : C.gold4) : mix(C.white, w0, 0.4));
    }
    g.globalAlpha = 1;
    // the near embankment: a stone wall with lamps along it
    const wall = mix(tone(GOTHIC, sky, 0.6), C.ink, 0.2);
    px(g, 0, h - 2, lw, 2, wall);
    for (let x = 9; x < lw; x += 24) {
      px(g, x, h - 6, 1, 4, mix(C.ink, wall, 0.4));
      px(g, x - 1, h - 7, 3, 1, night > 0.3 ? C.gold4 : mix(C.ink, wall, 0.4));
    }
    return bm;
  }

  /* ------------------------------------------------------------- New York */

  /** Midtown: a dense wall of towers with water tanks on their roofs, the Empire State and the Chrysler rising out of it. */
  private midtown(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 8;
    const glass = tone(GLASS, sky, 0.8), stone = tone(NY_STONE, sky, 0.8), brick = tone(NY_BRICK, sky, 0.8), steel = tone(STEEL_NY, sky, 0.6);
    const a = this.anchor(lw, 150);
    const esb = a + 14, chrys = a + 52;
    const taken: [number, number][] = [[esb - 4, esb + 18], [chrys - 3, chrys + 12]];
    const rr = rng(hash("midtown") ^ this.seed);
    let x = -3;
    while (x < lw) {
      const w = 5 + Math.floor(rr() * 7), th = Math.floor(h * (0.22 + rr() * 0.3));
      if (!taken.some(([l, r]) => x + w > l && x < r)) {
        block(g, sky, x, ground - th, w, th + 8, rr() < 0.3 ? glass : rr() < 0.5 ? brick : stone, 0.5);
        // the wooden water tank on its legs
        if (rr() < 0.4 && w > 5) {
          const tx = x + 1 + Math.floor(rr() * (w - 4));
          px(g, tx, ground - th - 4, 3, 3, tone(TANK, sky, 0.6));
          px(g, tx - 0 + 1, ground - th - 5, 1, 1, tone(TANK, sky, 0.6));
          px(g, tx, ground - th - 1, 1, 1, steel); px(g, tx + 2, ground - th - 1, 1, 1, steel);
        }
      }
      x += w + 1 + Math.floor(rr() * 2);
    }
    const lit = sky.lights;
    // the Empire State: art deco setbacks, the crown lit in colour at night, the mast
    const steps: [number, number, number][] = [[0, 16, 18], [2, 12, 30], [3, 10, 38], [4, 8, 42], [5, 6, 45]];
    for (const [dx, w, th] of steps) block(g, sky, esb + dx, ground - th, w, th, stone, 0.45);
    for (let i = 0; i < 4; i++) px(g, esb + 7, ground - 46 - i, 2, 1, i < 2 && lit > 0.3 ? C.blue4 : stone);
    px(g, esb + 7, ground - 50, 2, 1, lit > 0.3 ? C.terra4 : stone);
    px(g, esb + 8, ground - 57, 1, 7, steel);
    if (lit > 0.3) { g.globalAlpha = lit; px(g, esb + 5, ground - 45, 6, 3, C.blue4); px(g, esb + 6, ground - 48, 4, 2, C.gold4); px(g, esb + 8, ground - 57, 1, 1, C.red3); g.globalAlpha = 1; }
    // the Chrysler: a slim tower, the stacked arches of its steel crown with triangle windows, the needle
    block(g, sky, chrys, ground - 34, 9, 34, stone, 0.45);
    for (let i = 0; i < 5; i++) {
      const hw = 4 - Math.floor(i * 0.8), y = ground - 35 - i * 3;
      px(g, chrys + 4 - hw, y - 1, hw * 2 + 1, 3, steel);
      px(g, chrys + 4 - hw, y - 2, 1, 1, steel); px(g, chrys + 4 + hw, y - 2, 1, 1, steel);
      if (hw > 1) px(g, chrys + 4, y, 1, 1, lit > 0.3 ? C.white : mix(steel, C.ink, 0.4));
    }
    px(g, chrys + 4, ground - 56, 1, 7, steel);
    return bm;
  }

  /** Downtown on the water's edge: One World Trade, tapering to its spire, among the Financial District. */
  private downtown(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 8;
    const glass = tone(GLASS, sky, 0.75), stone = tone(NY_STONE, sky, 0.75);
    const a = this.anchor(lw, 150);
    const owt = a + 96;
    const rr = rng(hash("downtown") ^ this.seed);
    let x = owt - 30;
    while (x < owt + 40) {
      const w = 5 + Math.floor(rr() * 6), th = Math.floor(h * (0.18 + rr() * 0.22));
      if (x + w < owt - 2 || x > owt + 14) block(g, sky, x, ground - th, w, th + 8, rr() < 0.5 ? glass : stone, 0.45);
      x += w + 1 + Math.floor(rr() * 3);
    }
    const edge = mix(glass, sky.low, 0.35);
    const H = 52;
    for (let i = 0; i < H; i++) {
      const hw = Math.round(6 - (i / H) * 3.5);
      px(g, owt + 6 - hw, ground - i, hw * 2, 1, glass);
      px(g, owt + 6 - hw, ground - i, 1, 1, edge);
      if ((i + 1) % 6 === 0) px(g, owt + 6 - hw, ground - i, hw * 2, 1, mix(glass, sky.low, 0.2));
    }
    windows(g, sky, owt + 2, ground - H + 4, 8, H - 6, 0.35);
    px(g, owt + 6, ground - H - 10, 1, 10, tone(STEEL_NY, sky, 0.5));
    if (sky.lights > 0.3) px(g, owt + 6, ground - H - 10, 1, 1, C.white);
    return bm;
  }

  /** In front: the East River and the Brooklyn Bridge, its gothic stone towers and the cables swinging between them. */
  private brooklynBridge(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = this.river(lw, h, sky, "#4f6670");
    const g = bm.g;
    const lit = sky.lights;
    const stone = tone(BRIDGE_STONE, sky, 0.5), shade = mix(stone, C.ink, 0.35);
    const cable = mix(tone(C.slate5, sky, 0.4), lit > 0.4 ? C.white : sky.haze, 0.3);
    const a = this.anchor(lw, 150);
    const t1 = a + 30, t2 = a + 110, deck = h - 11, top = h - 34;
    // the deck from edge to edge, the lamps along it after dark
    px(g, 0, deck, lw, 2, shade);
    if (lit > 0.3) { g.globalAlpha = lit; for (let x = 3; x < lw; x += 6) px(g, x, deck - 1, 1, 1, C.gold4); g.globalAlpha = 1; }
    // the main cables: a sag between the towers, a slope out to the anchorages, hangers down to the deck
    const reach = 36;
    const sag = (x: number) => {
      if (x < t1) return top + 2 + ((t1 - x) / reach) * (deck - top - 2);
      if (x > t2) return top + 2 + ((x - t2) / reach) * (deck - top - 2);
      const u = (x - t1) / (t2 - t1);
      return top + 2 + (deck - top - 4) * 4 * u * (1 - u);
    };
    // only from anchorage to anchorage: the deck runs on alone beyond them
    for (let x = Math.max(0, t1 - reach); x < Math.min(lw, t2 + 9 + reach); x++) {
      const y = Math.round(sag(x));
      if (y >= deck) continue;
      px(g, x, y, 1, 1, cable);
      if (x % 4 === 0) { g.globalAlpha = 0.28; px(g, x, y + 1, 1, deck - y - 1, cable); g.globalAlpha = 1; }
    }
    // the diagonal stays fanning down from each tower
    for (const t of [t1, t2]) {
      for (let k = 1; k <= 4; k++) {
        for (const dir of [-1, 1]) {
          const len = k * 7;
          g.globalAlpha = 0.5;
          for (let i = 0; i < len; i++) px(g, Math.round(t + 4 + dir * i), Math.round(top + 4 + (i / len) * (deck - top - 4)), 1, 1, cable);
          g.globalAlpha = 1;
        }
      }
      // the tower: stone with two pointed gothic arches the deck runs through
      px(g, t, top, 9, h - top, stone);
      px(g, t + 8, top, 1, h - top, shade);
      px(g, t - 1, top, 11, 2, stone);
      for (const ax of [t + 1, t + 5]) {
        px(g, ax, top + 6, 3, deck - top - 4, mix(sky.mid, C.ink, 0.2 + lit * 0.5));
        px(g, ax + 1, top + 5, 1, 1, mix(sky.mid, C.ink, 0.2 + lit * 0.5));
      }
      px(g, t, deck, 9, 2, shade);
    }
    return bm;
  }

  /* ---------------------------------------------------------------- Tokyo */

  /** Far off: Mount Fuji, blue with distance under its snowcap, over a low band of city. */
  private fuji(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const night = sky.lights;
    const a = this.anchor(lw, 160);
    const cx = a + 34, W = 52, H = 38, base = h - 12;
    const rock = mix(mix(FUJI, sky.haze, 0.45), mix(sky.mid, C.ink, 0.35), night * 0.8);
    const snow = mix(mix(C.white, sky.low, 0.25), mix(sky.mid, C.slate4, 0.5), night * 0.75);
    for (let dx = -W; dx <= W; dx++) {
      const t = Math.abs(dx) / W;
      // concave flanks and a flat crater rim
      const top = Math.round(base - H * Math.pow(1 - Math.max(t, 0.06), 1.7) / Math.pow(0.94, 1.7));
      px(g, cx + dx, top, 1, base - top + 12, rock);
      // the snowcap, its lower edge torn into gullies
      const cap = Math.round(base - H * 0.62 + ((dx * 7 + 3) % 5) * (t > 0.08 ? 1 : 0) + (Math.abs(dx) % 4 === 0 ? 3 : 0));
      if (top < cap) px(g, cx + dx, top, 1, cap - top, dx > 0 ? mix(snow, rock, 0.2) : snow);
    }
    return bm;
  }

  /** The city: a dense field of pale towers, the Skytree rising far above them with its two observation decks. */
  private tokyoCity(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - CITY + 2;
    const a = this.anchor(lw, 160);
    const tree = a + 128;
    const paints = [GLASS, TOKYO_WHITE, TOKYO_GREY].map((c) => tone(c, sky, 0.8));
    const rr = rng(hash("tokyo") ^ this.seed);
    let x = -3;
    while (x < lw) {
      const w = 4 + Math.floor(rr() * 8), th = Math.floor(h * (0.16 + rr() * 0.28));
      if (x + w < a + 8 || x > a + 60 || th < 24) block(g, sky, x, ground - th, w, th + 6, paints[Math.floor(rr() * paints.length)]!, 0.55);
      // the red aircraft light on a roof
      if (sky.lights > 0.4 && rr() < 0.25) px(g, x + Math.floor(w / 2), ground - th - 1, 1, 1, C.red3);
      x += w + 1 + Math.floor(rr() * 2);
    }
    // the Skytree: a lattice tapering from a wide foot, two decks, the antenna on top
    const steel = night(sky) ? mix(C.blue4, C.white, 0.3) : tone(SKYTREE, sky, 0.6), shade = mix(steel, C.ink, 0.3);
    const ST = 56;
    for (let i = 0; i < ST; i++) {
      const hw = Math.max(1, Math.round(5 - (i / ST) * 4));
      px(g, tree - hw, ground - i, hw * 2 + 1, 1, (i + (i >> 2)) % 3 === 0 ? shade : steel);
      px(g, tree + hw, ground - i, 1, 1, shade);
    }
    for (const [y, hw] of [[34, 4], [45, 3]] as const) px(g, tree - hw, ground - y - 2, hw * 2 + 1, 3, night(sky) ? C.white : mix(steel, C.white, 0.3));
    px(g, tree, ground - ST - 8, 1, 8, shade);
    if (night(sky)) { g.globalAlpha = 0.5 * sky.lights; px(g, tree - 1, ground - ST + 2, 3, ST - 4, C.plum3); g.globalAlpha = 1; px(g, tree, ground - ST - 8, 1, 1, C.red3); }
    px(g, 0, ground, lw, h - ground, tone(TOKYO_GREY, sky, 0.85));
    return bm;
  }

  /** Tokyo Tower in its red and white bands, its legs splayed over the low roofs of Minato. */
  private tokyoTower(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 7;
    const a = this.anchor(lw, 160);
    const tx = a + 70;
    const rr = rng(hash("minato") ^ this.seed);
    const roofs = [TOKYO_WHITE, TOKYO_GREY, BRICK].map((c) => tone(c, sky, 0.85));
    let x = -2;
    while (x < lw) {
      const w = 5 + Math.floor(rr() * 7), th = 5 + Math.floor(rr() * 9);
      if (x + w < tx - 9 || x > tx + 10) block(g, sky, x, ground - th, w, th + 7, roofs[Math.floor(rr() * roofs.length)]!, 0.5);
      x += w + 1 + Math.floor(rr() * 2);
    }
    const lit = night(sky);
    const red = lit ? TOWER_LIT : tone(TOWER_RED, sky, 0.5), white = lit ? mix(TOWER_LIT, C.gold4, 0.5) : tone(C.white, sky, 0.5);
    const TH = 42;
    for (let i = 0; i < TH; i++) {
      const t = i / TH, hw = Math.max(0, Math.round(8 * Math.pow(1 - t, 2.1)));
      const band = Math.floor(i / 5) % 2 === 0 ? red : white;
      if (hw > 1 && i < 10) {
        // the open arch between the legs
        px(g, tx - hw, ground - i, 2, 1, band); px(g, tx + hw - 1, ground - i, 2, 1, band);
        if (i === 9) px(g, tx - hw, ground - i, hw * 2 + 1, 1, band);
      } else px(g, tx - hw, ground - i, hw * 2 + 1, 1, (i + tx) % 2 === 0 ? band : mix(band, C.ink, 0.15));
    }
    px(g, tx - 4, ground - 18, 9, 2, white);
    px(g, tx - 2, ground - 29, 5, 2, white);
    px(g, tx, ground - TH - 6, 1, 6, red);
    if (lit) {
      const glow = g.createRadialGradient(tx, ground - 20, 2, tx, ground - 20, 22);
      glow.addColorStop(0, rgba(TOWER_LIT, 0.35 * sky.lights));
      glow.addColorStop(1, rgba(TOWER_LIT, 0));
      g.fillStyle = glow;
      g.fillRect(tx - 22, ground - 44, 44, 44);
    }
    return bm;
  }

  /** In front: a row of cherry trees in blossom, petals on the path under them. */
  private sakura(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const n = sky.lights;
    const path = mix(mix(TOKYO_PATH, sky.haze, 0.1), mix(sky.mid, C.ink, 0.45), n * 0.85);
    px(g, 0, h - 4, lw, 4, path);
    px(g, 0, h - 4, lw, 1, mix(path, C.white, 0.2));
    const trunk = mix(SAKURA_BARK, C.ink, n * 0.6);
    const pink = mix(SAKURA, mix(sky.mid, C.ink, 0.3), n * 0.6), pinkLt = mix(SAKURA_LT, mix(sky.mid, C.ink, 0.2), n * 0.55);
    const rr = rng(hash("sakura") ^ this.seed);
    let x = 8;
    while (x < lw) {
      const th = 6 + Math.floor(rr() * 3), foot = h - 3;
      px(g, x, foot - th, 2, th, trunk);
      px(g, x - 2, foot - th + 1, 2, 1, trunk); px(g, x + 2, foot - th, 2, 1, trunk);
      // the canopy: overlapping blobs of blossom
      for (let k = 0; k < 7; k++) {
        const bx = x + 1 + Math.round((rr() - 0.5) * 12), by = foot - th - 2 + Math.round((rr() - 0.6) * 6), r = 3 + Math.floor(rr() * 2);
        for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r) px(g, bx + xx, by + yy, 1, 1, (xx + yy * 3 + k) % 4 === 0 ? pinkLt : pink);
      }
      for (let k = 0; k < 6; k++) px(g, x - 6 + Math.floor(rr() * 14), h - 3 + Math.floor(rr() * 3), 1, 1, pinkLt);
      x += 20 + Math.floor(rr() * 14);
    }
    return bm;
  }

  /* --------------------------------------------------------------- Warsaw */

  /** Śródmieście: the Palace of Culture and Science among Złota 44, Varso and the Warsaw Spire. */
  private warsawCity(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 8;
    const a = this.anchor(lw, 160);
    const palace = a + 24, zlota = a + 62, varso = a + 80, spire = a + 112;
    const glass = tone(GLASS, sky, 0.8), stone = tone(PALACE, sky, 0.8), block50 = tone(PRL_GREY, sky, 0.8);
    const edge = mix(glass, sky.low, 0.35);
    const taken: [number, number][] = [[palace - 14, palace + 15], [zlota - 2, zlota + 12], [varso - 2, varso + 10], [spire - 2, spire + 12]];
    const rr = rng(hash("warsaw") ^ this.seed);
    let x = -3;
    while (x < lw) {
      const w = 6 + Math.floor(rr() * 8), th = Math.floor(h * (0.14 + rr() * 0.26));
      if (!taken.some(([l, r]) => x + w > l && x < r)) block(g, sky, x, ground - th, w, th + 8, rr() < 0.4 ? glass : block50, 0.5);
      x += w + 1 + Math.floor(rr() * 3);
    }
    // the Palace of Culture: wings, then the tower stepping in, pinnacles on each step, the clock and the spire
    const steps: [number, number][] = [[13, 10], [9, 30], [7, 40], [5, 46], [3, 50]];
    let y0 = 0;
    for (const [hw, to] of steps) {
      px(g, palace - hw, ground - to, hw * 2 + 1, to - y0, stone);
      for (let c = palace - hw + 1; c < palace + hw; c += 2) px(g, c, ground - to + 1, 1, to - y0 - 1, mix(stone, C.ink, 0.12));
      px(g, palace + hw, ground - to, 1, to - y0, mix(stone, C.ink, 0.28));
      px(g, palace - hw, ground - to - 2, 1, 2, stone); px(g, palace + hw, ground - to - 2, 1, 2, stone);
      y0 = to;
    }
    windows(g, sky, palace - 8, ground - 30, 17, 28, 0.4);
    px(g, palace - 2, ground - 44, 5, 3, night(sky) ? C.gold4 : mix(C.white, stone, 0.3));
    px(g, palace, ground - 60, 1, 10, stone);
    if (night(sky)) { g.globalAlpha = 0.4 * sky.lights; px(g, palace - 5, ground - 46, 11, 16, C.plum3); g.globalAlpha = 1; }
    // Złota 44: one face straight, the other swelling out like a sail
    for (let i = 0; i < 44; i++) {
      const w = 6 + Math.round(Math.sin((i / 44) * Math.PI * 0.85) * 4);
      px(g, zlota, ground - i, w, 1, i % 3 === 0 ? mix(glass, C.ink, 0.14) : glass);
      px(g, zlota + w - 1, ground - i, 1, 1, edge);
    }
    windows(g, sky, zlota, ground - 42, 8, 40, 0.35);
    // Varso: slim glass, the tallest in the EU, a spire on top
    block(g, sky, varso, ground - 50, 8, 50, glass, 0.4);
    px(g, varso + 1, ground - 52, 6, 2, edge);
    px(g, varso + 4, ground - 63, 1, 11, edge);
    if (night(sky)) px(g, varso + 4, ground - 63, 1, 1, C.red3);
    // the Warsaw Spire: a curved glass tower with its mast
    for (let i = 0; i < 40; i++) {
      const w = 9 - Math.round((i / 40) ** 2 * 3);
      px(g, spire, ground - i, w, 1, i % 3 === 0 ? mix(glass, C.ink, 0.12) : glass);
      px(g, spire, ground - i, 1, 1, edge);
    }
    px(g, spire + 3, ground - 48, 1, 9, edge);
    return bm;
  }

  /** The Old Town on the escarpment: coloured houses with tall roofs, the Royal Castle's clock tower and Sigismund's Column. */
  private oldTown(lw: number, h: number, sky: SkyState): Bitmap {
    const bm = bitmap(lw, h);
    const g = bm.g;
    const ground = h - 7;
    const a = this.anchor(lw, 160);
    const castle = a + 6, column = a + 30;
    const roof = tone(ROOF, sky, 0.75), copper = tone(COPPER, sky, 0.7);
    const fronts = OLD_TOWN.map((c) => tone(c, sky, 0.75));
    const rr = rng(hash("oldtown") ^ this.seed);
    let x = -2;
    while (x < lw) {
      const w = 4 + Math.floor(rr() * 3), th = 8 + Math.floor(rr() * 6);
      if (x + w < castle - 2 || x > column + 4) {
        const c = fronts[Math.floor(rr() * fronts.length)]!;
        px(g, x, ground - th, w, th + 7, c);
        for (let i = 0; i < Math.ceil(w / 2) + 1; i++) px(g, x + i, ground - th - i, w - i * 2, 1, roof);
        for (let wy = ground - th + 2; wy < ground - 1; wy += 3) for (let wx = x + 1; wx < x + w - 1; wx += 2) px(g, wx, wy, 1, 1, night(sky) && rr() < 0.6 ? C.gold3 : mix(c, C.ink, 0.35));
      }
      x += w;
    }
    // the Royal Castle: a long terracotta front, the clock tower with its green copper spire
    const brick = tone(CASTLE, sky, 0.75);
    px(g, castle - 2, ground - 11, 24, 11, brick);
    for (let wx = castle; wx < castle + 21; wx += 3) px(g, wx, ground - 8, 1, 2, night(sky) ? C.gold3 : mix(brick, C.ink, 0.35));
    px(g, castle - 2, ground - 12, 24, 1, roof);
    px(g, castle + 8, ground - 24, 6, 13, brick);
    px(g, castle + 9, ground - 21, 4, 4, night(sky) ? C.gold4 : mix(C.white, brick, 0.3));
    for (let i = 0; i < 8; i++) { const hw = Math.max(0, Math.round(3 - i * 0.4)); px(g, castle + 11 - hw, ground - 25 - i, hw * 2 || 1, 1, copper); }
    px(g, castle + 11, ground - 35, 1, 2, GOLD);
    // Sigismund's Column: a tall pillar, the king on top with his cross
    const col = tone(C.slate5, sky, 0.6);
    px(g, column - 1, ground - 3, 4, 3, col);
    px(g, column, ground - 26, 2, 23, col);
    px(g, column - 1, ground - 27, 4, 1, col);
    px(g, column, ground - 31, 2, 4, tone(BRONZE, sky, 0.6));
    px(g, column + 2, ground - 33, 1, 3, tone(BRONZE, sky, 0.6));
    return bm;
  }

  /** A shamal: a beige veil over the view and sand streaming across it. */
  private dust(g: G, room: { x: number; w: number }, top: number, height: number, time: number) {
    g.globalAlpha = 0.22;
    px(g, room.x, top, room.w, height, SAND);
    g.fillStyle = SAND_LIT;
    const n = Math.floor(room.w / 2);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(room.x + ((i * 53.7 + time * (0.02 + (i % 5) * 0.006)) % room.w));
      const y = Math.floor(top + ((i * 29.3) % height) + Math.sin(time * 0.002 + i) * 2);
      g.globalAlpha = 0.2 + (i % 4) * 0.08;
      g.fillRect(x, y, 2, 1);
    }
    g.globalAlpha = 1;
  }

  /** Drizzle: a grey veil and fine streaks slanting down the glass. */
  private rain(g: G, room: { x: number; w: number }, top: number, height: number, time: number) {
    g.globalAlpha = 0.14;
    px(g, room.x, top, room.w, height, "#8d97a3");
    g.fillStyle = "#c3ccd8";
    const n = Math.floor(room.w / 3);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(room.x + ((i * 47.3 + time * 0.03) % room.w));
      const y = Math.floor(top + ((i * 23.9 + time * (0.09 + (i % 3) * 0.02)) % height));
      g.globalAlpha = 0.25 + (i % 3) * 0.1;
      g.fillRect(x, y, 1, 2);
      g.fillRect(x - 1, y + 2, 1, 1);
    }
    g.globalAlpha = 1;
  }

  /** Snow: a pale veil and flakes drifting down past the glass. */
  private snow(g: G, room: { x: number; w: number }, top: number, height: number, time: number) {
    g.globalAlpha = 0.12;
    px(g, room.x, top, room.w, height, "#dfe6ee");
    g.fillStyle = "#f4f7fb";
    const n = Math.floor(room.w / 3);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(room.x + ((i * 41.7 + Math.sin(time * 0.0012 + i) * 6 + room.w) % room.w));
      const y = Math.floor(top + ((i * 17.3 + time * (0.012 + (i % 4) * 0.004)) % height));
      g.globalAlpha = 0.45 + (i % 3) * 0.18;
      g.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }
    g.globalAlpha = 1;
  }

  /** Always 0: no lightning out there. Kept for the lighting pass. */
  flash = 0;

  /**
   * Paint the outside into the window rects. `ox` is the world x of the room's
   * left edge; `pan` the camera offset that drives parallax.
   */
  draw(g: CanvasRenderingContext2D, wins: { x: number; y: number; w: number; h: number }[], room: { x: number; w: number }, top: number, height: number, sky0: SkyState, time: number, pan: number, weather: Weather = "clear", vista?: { x: number; w: number }) {
    const dust = weather === "dust", wet = weather === "rain" || weather === "snow";
    // a shamal turns the sky beige and hides the stars; drizzle greys it over; London is a little grey anyway
    const grey = wet ? 0.45 : this.city === "london" ? 0.18 : 0;
    const sky = dust
      ? { ...sky0, top: mix(sky0.top, "#c9a878", 0.35), mid: mix(sky0.mid, "#c9a878", 0.45), low: mix(sky0.low, "#e0c08a", 0.55), stars: 0, sun: sky0.sun * 0.5 }
      : grey
        ? { ...sky0, top: mix(sky0.top, "#7d8794", grey), mid: mix(sky0.mid, "#9aa3ae", grey), low: mix(sky0.low, "#b4bac2", grey), stars: wet ? 0 : sky0.stars, sun: sky0.sun * (wet ? 0.35 : 0.8) }
        : sky0;
    this.build(room.w, height, sky, vista ? { x: vista.x - room.x + 80, w: vista.w } : { x: 0, w: 0 });
    g.save();
    g.beginPath();
    for (const r of wins) g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    // banded sky
    const bands = 9;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      g.fillStyle = t < 0.55 ? mix(sky.top, sky.mid, t / 0.55) : mix(sky.mid, sky.low, (t - 0.55) / 0.45);
      const y0 = top + Math.floor((height * i) / bands);
      const y1 = top + Math.floor((height * (i + 1)) / bands);
      g.fillRect(room.x, y0, room.w, y1 - y0);
    }
    // stars
    if (sky.stars > 0.02) {
      for (const s of this.stars) {
        const tw = 0.5 + 0.5 * Math.sin(time * 0.0018 + s.p * 7);
        const a = sky.stars * (0.35 + 0.65 * tw);
        if (a < 0.15) continue;
        g.globalAlpha = a;
        g.fillStyle = s.big ? C.gold4 : C.white;
        const x = Math.floor(room.x + s.x), y = Math.floor(top + s.y);
        g.fillRect(x, y, 1, 1);
        if (s.big && tw > 0.8) { g.globalAlpha = a * 0.5; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
      }
      g.globalAlpha = 1;
    }
    // sun / moon arc across the whole wall
    const h = sky.hour;
    if (!dust && !wet) {
    const isDay = h >= 6 && h < 18.5;
    const span = isDay ? (h - 6) / 12.5 : ((h >= 18.5 ? h - 18.5 : h + 5.5) / 11.5);
    const bx = room.x + 20 + span * (room.w - 40) - pan * 0.02;
    const by = top + height * 0.72 - Math.sin(span * Math.PI) * height * 0.58;
    if (isDay) {
      g.fillStyle = mix(C.gold4, sky.low, 0.2);
      g.globalAlpha = 0.25;
      g.beginPath(); g.arc(bx, by, 7, 0, 6.3); g.fill();
      g.globalAlpha = 1;
      g.fillStyle = C.gold4;
      g.fillRect(Math.floor(bx) - 2, Math.floor(by) - 3, 5, 7);
      g.fillRect(Math.floor(bx) - 3, Math.floor(by) - 2, 7, 5);
    } else {
      g.fillStyle = C.gold4;
      const mx = Math.floor(bx), my = Math.floor(by);
      g.fillRect(mx - 2, my - 3, 5, 7);
      g.fillRect(mx - 3, my - 2, 7, 5);
      g.fillStyle = sky.top;
      g.fillRect(mx, my - 3, 4, 5);
      g.fillRect(mx + 1, my + 2, 2, 1);
    }
    }
    // clouds
    const cloudA = dust ? 0.5 : wet ? 0.75 : sky.stars > 0.6 ? 0.18 : 0.6;
    for (const c of this.clouds) {
      const x = Math.floor(room.x + ((c.x + time * 0.0016 * c.s - pan * 0.03) % (room.w + 60)) - 30);
      const y = Math.floor(top + c.y);
      g.globalAlpha = cloudA;
      g.fillStyle = sky.stars > 0.6 ? C.slate2 : mix(C.white, sky.low, 0.25);
      g.fillRect(x + 2, y, c.w - 4, 1);
      g.fillRect(x, y + 1, c.w, 2);
      g.fillRect(x + 4, y - 1, Math.floor(c.w / 3), 1);
      g.fillStyle = sky.stars > 0.6 ? C.slate1 : mix(C.slate5, sky.mid, 0.3);
      g.fillRect(x + 1, y + 3, c.w - 2, 1);
    }
    g.globalAlpha = 1;
    // city, far to near
    for (const l of this.layers) {
      const off = Math.floor(-80 - pan * l.par);
      g.drawImage(l.bm.c, room.x + off, top);
    }
    if (dust) this.dust(g, room, top, height, time);
    if (weather === "rain") this.rain(g, room, top, height, time);
    if (weather === "snow") this.snow(g, room, top, height, time);
    g.restore();
  }
}
