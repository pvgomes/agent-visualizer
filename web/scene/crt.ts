/*
 * CRT post-pass, applied to the finished canvas so screen recordings and PNG
 * exports carry it: red/cyan channel split (chromatic aberration), a cheap
 * bloom from a downsampled copy, scanlines, a soft flicker and a vignette with
 * rounded tube corners.
 */
import { bitmap, type Bitmap } from "./util.ts";

export class Crt {
  private w = 0;
  private h = 0;
  private red: Bitmap | null = null;
  private cyan: Bitmap | null = null;
  private b1: Bitmap | null = null;
  private b2: Bitmap | null = null;
  private vignette: Bitmap | null = null;
  private scan: CanvasPattern | null = null;

  private ensure(w: number, h: number, dpr: number, g: CanvasRenderingContext2D) {
    if (w === this.w && h === this.h && this.red) return;
    this.w = w; this.h = h;
    this.red = bitmap(w, h);
    this.cyan = bitmap(w, h);
    this.b1 = bitmap(Math.ceil(w / 4), Math.ceil(h / 4));
    this.b2 = bitmap(Math.ceil(w / 12), Math.ceil(h / 12));
    for (const b of [this.b1, this.b2]) { b.g.imageSmoothingEnabled = true; b.g.imageSmoothingQuality = "high"; }
    const period = Math.max(2, Math.round(1.5 * dpr));
    const sc = bitmap(1, period * 2);
    sc.g.fillStyle = "rgba(0,0,0,0.32)";
    sc.g.fillRect(0, period, 1, Math.max(1, Math.round(period * 0.6)));
    sc.g.fillStyle = "rgba(0,0,0,0.12)";
    sc.g.fillRect(0, 0, 1, Math.max(1, Math.round(period * 0.4)));
    this.scan = g.createPattern(sc.c, "repeat");
    const v = bitmap(w, h);
    const grad = v.g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.hypot(w, h) * 0.58);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.7, "rgba(0,0,0,0.28)");
    grad.addColorStop(1, "rgba(0,0,0,0.75)");
    v.g.fillStyle = grad;
    v.g.fillRect(0, 0, w, h);
    // rounded tube corners
    const rad = Math.min(w, h) * 0.035;
    v.g.fillStyle = "#000";
    v.g.beginPath();
    v.g.rect(0, 0, w, h);
    v.g.roundRect(0, 0, w, h, rad);
    v.g.fill("evenodd");
    this.vignette = v;
  }

  apply(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number, t: number) {
    const w = canvas.width, h = canvas.height;
    this.ensure(w, h, dpr, g);
    const red = this.red!, cyan = this.cyan!, b1 = this.b1!, b2 = this.b2!;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    // channel split
    for (const [b, col] of [[red, "#ff0000"], [cyan, "#00ffff"]] as const) {
      b.g.globalCompositeOperation = "source-over";
      b.g.drawImage(canvas, 0, 0);
      b.g.globalCompositeOperation = "multiply";
      b.g.fillStyle = col;
      b.g.fillRect(0, 0, w, h);
    }
    const off = Math.max(1, Math.round(dpr * 1.2));
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    g.drawImage(cyan.c, off * 0.5, 0);
    g.globalCompositeOperation = "lighter";
    g.drawImage(red.c, -off, 0);
    // bloom
    b1.g.clearRect(0, 0, b1.w, b1.h);
    b1.g.drawImage(canvas, 0, 0, b1.w, b1.h);
    b2.g.clearRect(0, 0, b2.w, b2.h);
    b2.g.drawImage(b1.c, 0, 0, b2.w, b2.h);
    g.globalCompositeOperation = "screen";
    g.imageSmoothingEnabled = true;
    g.globalAlpha = 0.22;
    g.drawImage(b1.c, 0, 0, w, h);
    g.globalAlpha = 0.3;
    g.drawImage(b2.c, 0, 0, w, h);
    g.globalAlpha = 1;
    // scanlines + flicker
    g.globalCompositeOperation = "source-over";
    g.fillStyle = this.scan!;
    g.fillRect(0, 0, w, h);
    const fl = 0.025 + 0.02 * Math.sin(t * 0.06) * Math.sin(t * 0.0013);
    g.fillStyle = `rgba(0,0,0,${Math.max(0, fl)})`;
    g.fillRect(0, 0, w, h);
    // rolling bright band
    const by = ((t * 0.05) % (h + 200)) - 100;
    const band = g.createLinearGradient(0, by - 60, 0, by + 60);
    band.addColorStop(0, "rgba(255,255,255,0)");
    band.addColorStop(0.5, "rgba(255,255,255,0.025)");
    band.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = band;
    g.fillRect(0, by - 60, w, 120);
    g.drawImage(this.vignette!.c, 0, 0);
    g.restore();
  }
}
