"use client";

/**
 * The animated dot-matrix wordmark: the product name drawn as a grid of coloured dots (mostly muted greys, some light,
 * some in the brand colours) that fly in from a scattered cloud the first time it scrolls into view, then scatter away
 * from the pointer (or a tap) and spring back. Used by the dashboard's welcome panel. Canvas 2D, set up in effects only,
 * so the server renders an empty box of the right height. It never prevents page scrolling, never takes focus, never
 * animates under prefers-reduced-motion and stops its animation loop whenever nothing moves.
 */

import { useEffect, useRef, type JSX } from "react";
import { cn } from "cn";
import { PRODUCT_NAME } from "./brand";

export interface DotWordmarkProps {
  /** the word to draw; default PRODUCT_NAME.toLowerCase() from ./brand */
  text?: string;
  className?: string;
  /** CSS height of the drawing in px at full width (default 120); the width follows the container */
  height?: number;
}

const FONT = '"Atkinson Hyperlegible Next", ui-sans-serif, system-ui, sans-serif';
const FONT_PROBE = '800 100px "Atkinson Hyperlegible Next"';
const GREYS = ["#3a4258", "#4b5570", "#5e6a85", "#8a93a8"];
const LIGHTS = ["#e8ebf4", "#c9cfdc"];
/** Teal, violet and coral twice as often as the deep green and the plum. */
const ACCENTS = ["#2dd4bf", "#7c6cff", "#ff7a6b", "#2dd4bf", "#7c6cff", "#ff7a6b", "#2f6b4f", "#6b2f55"];
const MAX_DOTS = 2600;
const TRACKING = 6; // extra space between letters, in px at a 100 px font
const REACH = 70; // CSS px around the pointer that push dots away
const PUSH = 14000; // px/s² at the pointer, falling to 0 at REACH
const KICK = 520; // px/s: the impulse of a click or tap
const SPRING = 90; // s⁻²: the pull back to the dot's place
const DAMPING = 8.5; // s⁻¹: about 0.45 of critical, so one soft overshoot
const INTRO_MS = 1000; // each dot's flight
const STAGGER_MS = 450; // left-to-right delay across the word
const TAU = Math.PI * 2;

/** t: its place in the word; s: where the intro starts it; o and v: spring offset and velocity; x, y: where it is drawn. */
interface Dot { tx: number; ty: number; sx: number; sy: number; delay: number; ox: number; oy: number; vx: number; vy: number; x: number; y: number }
interface Layout { dots: Dot[]; groups: { color: string; dots: Dot[] }[]; radius: number }

/** mulberry32 seeded with a hash of the word: the same colours and cloud on every load. */
function seeded(text: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean alpha (0 to 1) of the pixels in the square of side 2·half around (cx, cy). */
function coverage(alpha: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, half: number): number {
  const x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(w, Math.round(cx + half));
  const y0 = Math.max(0, Math.round(cy - half)), y1 = Math.min(h, Math.round(cy + half));
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += alpha[(y * w + x) * 4 + 3];
  const n = (x1 - x0) * (y1 - y0);
  return n > 0 ? sum / (n * 255) : 0;
}

/** Draws the word offscreen, fitted to w × h CSS px from the left edge, and makes one dot per grid cell the ink mostly covers. */
function layoutDots(word: string, w: number, h: number): Layout | null {
  const pw = Math.ceil(w), ph = Math.ceil(h);
  const probe = document.createElement("canvas");
  probe.width = pw;
  probe.height = ph;
  const g = probe.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  const chars = Array.from(word);
  g.font = `800 100px ${FONT}`;
  const m = g.measureText(word);
  const asc = m.actualBoundingBoxAscent || 75, desc = m.actualBoundingBoxDescent || 20;
  const advances = chars.map((c) => g.measureText(c).width);
  const wide = advances.reduce((s, a) => s + a, 0) + TRACKING * (chars.length - 1);
  const padX = Math.max(3, h * 0.04), padY = Math.max(6, h * 0.08);
  const scale = Math.max(0.05, Math.min((w - 2 * padX) / wide, (h - 2 * padY) / (asc + desc)));
  g.font = `800 ${100 * scale}px ${FONT}`;
  const base = (h - (asc + desc) * scale) / 2 + asc * scale;
  let pen = padX;
  chars.forEach((c, i) => {
    g.fillText(c, pen, base);
    pen += (advances[i] + TRACKING) * scale;
  });
  const alpha = g.getImageData(0, 0, pw, ph).data;
  probe.width = probe.height = 0; // free the bitmap now (Safari caps total canvas memory)

  // The pitch follows the font size (about 8 px at the default height, less on a narrow phone); coarser if over MAX_DOTS.
  const inkMid = base - ((asc - desc) * scale) / 2;
  let pitch = Math.min(8, Math.max(3, (100 * scale) / 15));
  let cells: [number, number][] = [];
  for (let tries = 0; tries < 6; tries++) {
    cells = [];
    for (let y = inkMid - Math.floor(inkMid / pitch) * pitch; y < h; y += pitch) {
      for (let x = padX + pitch / 2; x < w; x += pitch) if (coverage(alpha, pw, ph, x, y, pitch / 2) >= 0.34) cells.push([x, y]);
    }
    if (cells.length <= MAX_DOTS) break;
    pitch *= Math.sqrt(cells.length / MAX_DOTS) * 1.02;
  }

  const rand = seeded(word);
  const xs = cells.map(([x]) => x);
  const minX = Math.min(...xs), span = Math.max(1, Math.max(...xs) - minX);
  const groups = new Map<string, Dot[]>();
  const dots = cells.map(([tx, ty]) => {
    const r = rand();
    const list = r < 0.45 ? GREYS : r < 0.65 ? LIGHTS : ACCENTS;
    const color = list[Math.floor(rand() * list.length)];
    const sx = (rand() * 1.3 - 0.15) * w, sy = (rand() * 2 - 0.5) * h;
    const dot: Dot = { tx, ty, sx, sy, delay: ((tx - minX) / span) * STAGGER_MS + rand() * 120, ox: 0, oy: 0, vx: 0, vy: 0, x: tx, y: ty };
    let group = groups.get(color);
    if (!group) groups.set(color, (group = []));
    group.push(dot);
    return dot;
  });
  return { dots, groups: Array.from(groups, ([color, ds]) => ({ color, dots: ds })), radius: pitch * 0.38 };
}

export function DotWordmark({ text, className, height = 120 }: DotWordmarkProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const word = text?.trim() || PRODUCT_NAME.toLowerCase();
  const label = text?.trim() || PRODUCT_NAME;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listeners = new AbortController();
    const pointer = { x: 0, y: 0, active: false };
    let reduced = motion.matches;
    let layout: Layout | null = null;
    let dpr = 1, builtWidth = -1;
    let fontsReady = false, cancelled = false;
    let seen = typeof IntersectionObserver === "undefined";
    let introStarted = false, introDone = false;
    let introClock = 0; // ms of intro played; it advances only on frames, so a hidden tab pauses it
    let raf = 0, last = 0, resizeTimer = 0, fontTimer = 0;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height); // more than the CSS box, so no rounded edge column is left
      if (!layout) return;
      const r = layout.radius;
      for (const group of layout.groups) {
        ctx.fillStyle = group.color;
        ctx.beginPath();
        for (const d of group.dots) {
          ctx.moveTo(d.x + r, d.y);
          ctx.arc(d.x, d.y, r, 0, TAU);
        }
        ctx.fill();
      }
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = last = 0;
    };
    const schedule = () => {
      if (raf || reduced || document.hidden || !layout || (!introDone && !introStarted)) return;
      raf = requestAnimationFrame(frame);
    };
    const settle = () => layout?.dots.forEach((d) => Object.assign(d, { ox: 0, oy: 0, vx: 0, vy: 0, x: d.tx, y: d.ty }));

    function frame(now: number) {
      raf = 0;
      if (!layout) return;
      const raw = last ? now - last : 1000 / 60;
      const dt = Math.min(raw / 1000, 1 / 30);
      last = now;
      if (!introDone) introClock += Math.min(raw, 100);
      let flying = false, moving = false;
      for (const d of layout.dots) {
        let hx = d.tx, hy = d.ty;
        if (!introDone) {
          const t = Math.min(1, Math.max(0, (introClock - d.delay) / INTRO_MS));
          if (t < 1) {
            flying = true;
            const e = 1 - (1 - t) ** 3;
            hx = d.sx + (d.tx - d.sx) * e;
            hy = d.sy + (d.ty - d.sy) * e;
          }
        }
        let ax = -SPRING * d.ox - DAMPING * d.vx, ay = -SPRING * d.oy - DAMPING * d.vy;
        if (pointer.active) {
          const dx = hx + d.ox - pointer.x, dy = hy + d.oy - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < REACH && dist > 0.01) {
            const f = (PUSH * (1 - dist / REACH) ** 2) / dist;
            ax += dx * f;
            ay += dy * f;
          }
        }
        d.vx += ax * dt; // semi-implicit Euler: velocity first, then position
        d.vy += ay * dt;
        d.ox += d.vx * dt;
        d.oy += d.vy * dt;
        d.x = hx + d.ox;
        d.y = hy + d.oy;
        // Still moving unless slow and balanced (a swing's turning point is slow but not balanced).
        if (Math.abs(d.vx) + Math.abs(d.vy) > 3 || Math.abs(ax) + Math.abs(ay) > 30) moving = true;
      }
      if (!flying) introDone = true;
      if (!flying && !moving) {
        last = 0;
        if (!pointer.active) settle();
      }
      draw();
      if (flying || moving) schedule();
    }

    /** After a build, on first sight and on a motion-preference change: the settled word, or the intro. */
    const show = () => {
      if (!layout) return;
      if (reduced || introDone) {
        stop();
        introDone = true;
        settle();
        draw();
      } else if (seen) {
        introStarted = true;
        introClock = 0;
        stop();
        schedule();
      }
    };

    const rebuild = () => {
      if (!fontsReady || cancelled) return;
      const w = wrap.getBoundingClientRect().width;
      builtWidth = Math.round(w);
      stop();
      dpr =Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      layout = w >= 1 ? layoutDots(word, w, height) : null;
      show();
    };

    // Fonts: wait for the app font for at most 1.5 s, then draw with whatever loaded (and redraw if it arrives later).
    let timedOut = false;
    const fontLoad: Promise<boolean> = document.fonts
      ? document.fonts.load(FONT_PROBE).then((faces) => faces.length > 0, () => false)
      : Promise.resolve(false);
    const timeout = new Promise<void>((resolve) => {
      fontTimer = window.setTimeout(resolve, 1500);
    }).then(() => {
      timedOut = true;
    });
    void Promise.race([fontLoad, timeout]).then(() => {
      window.clearTimeout(fontTimer);
      fontsReady = true;
      rebuild();
    });
    void fontLoad.then((ok) => {
      if (ok && timedOut) rebuild();
    });

    const io = seen ? null : new IntersectionObserver((entries, observer) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      seen = true;
      show();
    }, { threshold: 0.3 });
    io?.observe(wrap);

    // Rebuild on width changes only (the height is the prop), debounced, and only if the width really changed.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => Math.round(wrap.getBoundingClientRect().width) !== builtWidth && rebuild(), 150);
    });
    ro?.observe(wrap);

    // Pointer: a mouse or pen pushes while over the canvas, a touch while down. Passive listeners, no preventDefault.
    const live = () => !reduced && (introDone || introStarted);
    const place = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    };
    const release = () => {
      pointer.active = false;
      schedule();
    };
    const onMove = (e: PointerEvent) => {
      if (!live()) return;
      place(e);
      schedule();
    };
    const onDown = (e: PointerEvent) => {
      if (!live() || !layout) return;
      place(e);
      for (const d of layout.dots) {
        const dx = d.x - pointer.x, dy = d.y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < REACH && dist > 0.01) {
          const k = (KICK * (1 - dist / REACH)) / dist;
          d.vx += dx * k;
          d.vy += dy * k;
        }
      }
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") release();
    };
    const onMotion = () => {
      reduced = motion.matches;
      if (reduced) pointer.active = false;
      show();
    };
    const onVisibility = () => (document.hidden ? stop() : schedule());
    const opts = { passive: true, signal: listeners.signal };
    canvas.addEventListener("pointermove", onMove, opts);
    canvas.addEventListener("pointerdown", onDown, opts);
    canvas.addEventListener("pointerup", onUp, opts);
    canvas.addEventListener("pointerleave", release, opts);
    canvas.addEventListener("pointercancel", release, opts);
    document.addEventListener("visibilitychange", onVisibility, opts);
    motion.addEventListener("change", onMotion, opts);

    return () => {
      cancelled = true;
      stop();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(fontTimer);
      io?.disconnect();
      ro?.disconnect();
      listeners.abort();
    };
  }, [word, height]);

  return (
    <div ref={wrapRef} className={cn("w-full max-w-full overflow-hidden", className)} style={{ height }}>
      <canvas ref={canvasRef} role="img" aria-label={label} className="block size-full" />
    </div>
  );
}
