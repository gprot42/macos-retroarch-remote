import { invoke } from "@tauri-apps/api/core";

type Settings = {
  host: string;
  user: string;
  sshKey: string;
  port: number;
  scriptPath: string;
  sshExtra: string;
  raDir: string;
  disksDir: string;
  systemDir: string;
  corePath: string;
};

type KeyDef = {
  label: string;
  shiftLabel?: string;
  key: string;
  ch?: string;
  shiftCh?: string;
  wide?: "wide" | "wider" | "space" | "shift" | "tab" | "caps" | "ctrl" | "alt" | "amiga";
  cls?: string;
  /** Show dual legend (shift glyph above primary) like a real A500 keycap */
  dual?: boolean;
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const $input = (id: string) => document.getElementById(id) as HTMLInputElement;

function status(msg: string) {
  $("status").textContent = msg;
}

async function loadSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("load_settings");
  } catch {
    return await invoke<Settings>("default_settings");
  }
}

let settings: Settings | null = null;
let busy = false;
/** Accumulated TV-space deltas (may be fractional until flush). */
let pendingDx = 0;
let pendingDy = 0;
/** Residual after integer send so sub-pixel moves aren't lost. */
let residualDx = 0;
let residualDy = 0;
let flushTimer: number | null = null;
/** Only one SSH mouse-move in flight — coalesce the rest so the pad stays responsive */
let moveInFlight = false;
let moveErrors = 0;
let shiftOn = false;
/** Local Caps Lock sticky state (also injects Capslock to the TV). */
let capsOn = false;
/** When true, physical keys go to the type-input, not the TV */
let ignorePhysical = false;
/**
 * game = inject into ClickableMouse only (no system cursor — keeps music playing).
 * pointer = webOS Magic Remote path (visible cursor; can pause fullscreen audio).
 */
let mouseMode: "game" | "pointer" = "game";

const SPEED_KEY = "ra-mouse-speed";
/** Bump when retuning defaults so old aggressive settings get reset once. */
const SPEED_TUNE_KEY = "ra-mouse-speed-tune";
const SPEED_TUNE_VER = "3"; // v3 = controllable, non-jumpy

function speed(): number {
  const v = Number($input("speed").value);
  return Number.isFinite(v) ? v : 5;
}

/**
 * Map slider 1-10 → base gain.
 * Kept modest so the pointer does not leap ahead of the finger.
 */
function speedGain(slider: number): number {
  // 1→0.75 · 3→1.2 · 5→1.8 · 7→2.5 · 10→3.8
  const t = Math.max(1, Math.min(10, slider));
  return 0.45 + t * 0.26 + (t * t) * 0.007;
}

/**
 * Mild acceleration only — strong boosts made the cursor jump.
 */
function accelGain(mag: number): number {
  if (mag <= 0) return 0;
  // ~1.0 at 2px, ~1.25 at 12px, ~1.55 at 28px, hard cap 1.65
  const g = 0.95 + Math.pow(Math.min(mag, 36) / 14, 0.85) * 0.55;
  return Math.min(1.65, Math.max(0.9, g));
}

/**
 * Transform raw pad deltas into TV-space REL units.
 * Caps per-sample distance so a single event never teleports the cursor.
 */
function mapPadToTv(rawDx: number, rawDy: number, precision: boolean): {
  dx: number;
  dy: number;
} {
  const mag = Math.hypot(rawDx, rawDy);
  if (mag === 0) return { dx: 0, dy: 0 };
  let gain = speedGain(speed()) * accelGain(mag);
  // Shift = precision aim (very fine)
  if (precision) gain *= 0.28;
  let dx = rawDx * gain;
  let dy = rawDy * gain;
  // Hard cap per sample (TV pixels). Stops "jumps" when movementX spikes.
  const maxStep = precision ? 28 : 72;
  const outMag = Math.hypot(dx, dy);
  if (outMag > maxStep) {
    const s = maxStep / outMag;
    dx *= s;
    dy *= s;
  }
  return { dx, dy };
}

function queueMove(dx: number, dy: number) {
  if (!settings) {
    status("No settings — close and reopen this window");
    return;
  }
  pendingDx += dx;
  pendingDy += dy;
  if (flushTimer == null && !moveInFlight) {
    // Steady ~60Hz coalescing — avoids burst packets that feel like jumps
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flushMove();
    }, 16);
  }
}

async function flushMove() {
  if (moveInFlight) return;
  if (!settings) return;

  // Apply residual from previous flush for smooth continuous motion
  let fx = pendingDx + residualDx;
  let fy = pendingDy + residualDy;
  pendingDx = 0;
  pendingDy = 0;

  let dx = Math.trunc(fx);
  let dy = Math.trunc(fy);
  residualDx = fx - dx;
  residualDy = fy - dy;

  // Never drop a meaningful move to zero
  if (dx === 0 && Math.abs(fx) >= 0.45) {
    dx = fx > 0 ? 1 : -1;
    residualDx = fx - dx;
  }
  if (dy === 0 && Math.abs(fy) >= 0.45) {
    dy = fy > 0 ? 1 : -1;
    residualDy = fy - dy;
  }
  if (dx === 0 && dy === 0) return;

  // Cap coalesced packet — large dumps felt like the cursor leaping ahead
  dx = Math.max(-280, Math.min(280, dx));
  dy = Math.max(-280, Math.min(280, dy));

  moveInFlight = true;
  try {
    await invoke("ra_mouse_move", {
      settings,
      dx,
      dy,
      mode: mouseMode,
    });
    moveErrors = 0;
  } catch (e) {
    moveErrors += 1;
    status(String(e));
    // Back off briefly after repeated failures so we don't spam a dead SSH
    if (moveErrors >= 3) {
      await new Promise((r) => setTimeout(r, 350));
    }
  } finally {
    moveInFlight = false;
    // Send any movement that arrived while we were in flight
    if (pendingDx !== 0 || pendingDy !== 0) {
      void flushMove();
    }
  }
}

async function click(side: "left" | "right") {
  if (!settings) return;
  if (busy) {
    status("busy — try again");
    return;
  }
  busy = true;
  try {
    const cmd = side === "left" ? "ra_click_left" : "ra_click_right";
    const r = await invoke<string>(cmd, { settings, times: 1 });
    status(r.trim() || `${side} click ok`);
  } catch (e) {
    try {
      await invoke("ra_mouse_button", {
        settings,
        action: "down",
        button: side,
      });
      await new Promise((r) => setTimeout(r, 120));
      await invoke("ra_mouse_button", {
        settings,
        action: "up",
        button: side,
      });
      status(`${side} click (hold path)`);
    } catch (e2) {
      status(String(e2));
    }
  } finally {
    busy = false;
  }
}

async function button(action: "down" | "up", side: "left" | "right") {
  if (!settings) return;
  try {
    const r = await invoke<string>("ra_mouse_button", {
      settings,
      action,
      button: side,
    });
    if (r?.trim()) status(r.trim());
  } catch (e) {
    status(String(e));
  }
}

async function sendNamedKey(key: "esc" | "enter") {
  if (!settings) return;
  enqueueKey(key, false);
}

/** Toggle system-pointer mode (menus). Off by default so in-game music keeps playing. */
async function toggleSystemCursorMode() {
  if (!settings) return;
  const btn = document.getElementById("btn-show-cursor") as HTMLButtonElement | null;
  if (mouseMode === "game") {
    mouseMode = "pointer";
    btn?.classList.add("active");
    btn?.setAttribute("aria-pressed", "true");
    try {
      const r = await invoke<string>("ra_show_cursor", { settings });
      status(
        (r?.trim() || "System cursor on") +
          " — may pause music; click again for game mode",
      );
    } catch (e) {
      status(`System cursor on (show failed: ${e})`);
    }
  } else {
    mouseMode = "game";
    btn?.classList.remove("active");
    btn?.setAttribute("aria-pressed", "false");
    status("Game mouse mode — no system cursor (music stays on)");
  }
}

function initTheme() {
  try {
    const t = localStorage.getItem("ra-theme");
    if (t === "light" || t === "tokyo-night" || t === "midnight") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch {
    /* ignore */
  }
  window.addEventListener("storage", (e) => {
    if (e.key === "ra-theme" && e.newValue) {
      const t = e.newValue;
      if (t === "light" || t === "tokyo-night" || t === "midnight") {
        document.documentElement.setAttribute("data-theme", t);
      }
    }
  });
}

/* ── Keyboard layouts ────────────────────────────────────── */
type KbMode = "a500" | "generic";
const KB_MODE_KEY = "ra-kb-mode";
let kbMode: KbMode = "a500";

function loadKbMode(): KbMode {
  try {
    const v = localStorage.getItem(KB_MODE_KEY);
    if (v === "a500" || v === "generic") return v;
  } catch {
    /* ignore */
  }
  return "a500";
}

function saveKbMode(mode: KbMode) {
  try {
    localStorage.setItem(KB_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Commodore Amiga 500 — Esc, F1–F10, Help, Amiga keys, dual legends. */
const A500_ROWS: KeyDef[][] = [
  [
    { label: "Esc", key: "esc", cls: "fn a500-esc", wide: "wide" },
    { label: "F1", key: "f1", cls: "fn g-f1" },
    { label: "F2", key: "f2", cls: "fn g-f1" },
    { label: "F3", key: "f3", cls: "fn g-f1" },
    { label: "F4", key: "f4", cls: "fn g-f1" },
    { label: "F5", key: "f5", cls: "fn g-f1" },
    { label: "F6", key: "f6", cls: "fn g-f2" },
    { label: "F7", key: "f7", cls: "fn g-f2" },
    { label: "F8", key: "f8", cls: "fn g-f2" },
    { label: "F9", key: "f9", cls: "fn g-f2" },
    { label: "F10", key: "f10", cls: "fn g-f2" },
    { label: "Del", key: "delete", cls: "fn a500-special g-help", wide: "wide" },
    { label: "Help", key: "help", cls: "fn a500-help g-help", wide: "wide" },
  ],
  [
    { label: "`", shiftLabel: "~", key: "grave", ch: "`", shiftCh: "~", dual: true },
    { label: "1", shiftLabel: "!", key: "1", ch: "1", shiftCh: "!", dual: true },
    { label: "2", shiftLabel: "@", key: "2", ch: "2", shiftCh: "@", dual: true },
    { label: "3", shiftLabel: "#", key: "3", ch: "3", shiftCh: "#", dual: true },
    { label: "4", shiftLabel: "$", key: "4", ch: "4", shiftCh: "$", dual: true },
    { label: "5", shiftLabel: "%", key: "5", ch: "5", shiftCh: "%", dual: true },
    { label: "6", shiftLabel: "^", key: "6", ch: "6", shiftCh: "^", dual: true },
    { label: "7", shiftLabel: "&", key: "7", ch: "7", shiftCh: "&", dual: true },
    { label: "8", shiftLabel: "*", key: "8", ch: "8", shiftCh: "*", dual: true },
    { label: "9", shiftLabel: "(", key: "9", ch: "9", shiftCh: "(", dual: true },
    { label: "0", shiftLabel: ")", key: "0", ch: "0", shiftCh: ")", dual: true },
    { label: "-", shiftLabel: "_", key: "minus", ch: "-", shiftCh: "_", dual: true },
    { label: "=", shiftLabel: "+", key: "equal", ch: "=", shiftCh: "+", dual: true },
    { label: "\\", shiftLabel: "|", key: "backslash", ch: "\\", shiftCh: "|", dual: true },
    { label: "←", key: "backspace", wide: "wider", cls: "mod a500-bksp" },
  ],
  [
    { label: "Tab", key: "tab", wide: "tab", cls: "mod" },
    { label: "Q", key: "q", ch: "q", shiftCh: "Q" },
    { label: "W", key: "w", ch: "w", shiftCh: "W" },
    { label: "E", key: "e", ch: "e", shiftCh: "E" },
    { label: "R", key: "r", ch: "r", shiftCh: "R" },
    { label: "T", key: "t", ch: "t", shiftCh: "T" },
    { label: "Y", key: "y", ch: "y", shiftCh: "Y" },
    { label: "U", key: "u", ch: "u", shiftCh: "U" },
    { label: "I", key: "i", ch: "i", shiftCh: "I" },
    { label: "O", key: "o", ch: "o", shiftCh: "O" },
    { label: "P", key: "p", ch: "p", shiftCh: "P" },
    { label: "[", shiftLabel: "{", key: "lbrace", ch: "[", shiftCh: "{", dual: true },
    { label: "]", shiftLabel: "}", key: "rbrace", ch: "]", shiftCh: "}", dual: true },
  ],
  [
    { label: "Ctrl", key: "ctrl", wide: "ctrl", cls: "mod a500-ctrl" },
    { label: "Caps\nLock", key: "caps", wide: "caps", cls: "mod multilabel" },
    { label: "A", key: "a", ch: "a", shiftCh: "A" },
    { label: "S", key: "s", ch: "s", shiftCh: "S" },
    { label: "D", key: "d", ch: "d", shiftCh: "D" },
    { label: "F", key: "f", ch: "f", shiftCh: "F" },
    { label: "G", key: "g", ch: "g", shiftCh: "G" },
    { label: "H", key: "h", ch: "h", shiftCh: "H" },
    { label: "J", key: "j", ch: "j", shiftCh: "J" },
    { label: "K", key: "k", ch: "k", shiftCh: "K" },
    { label: "L", key: "l", ch: "l", shiftCh: "L" },
    { label: ";", shiftLabel: ":", key: "semicolon", ch: ";", shiftCh: ":", dual: true },
    { label: "'", shiftLabel: '"', key: "apostrophe", ch: "'", shiftCh: '"', dual: true },
    { label: "Return", key: "enter", wide: "wider", cls: "enter a500-return" },
  ],
  [
    { label: "Shift", key: "shift", wide: "shift", cls: "mod a500-shift" },
    { label: "Z", key: "z", ch: "z", shiftCh: "Z" },
    { label: "X", key: "x", ch: "x", shiftCh: "X" },
    { label: "C", key: "c", ch: "c", shiftCh: "C" },
    { label: "V", key: "v", ch: "v", shiftCh: "V" },
    { label: "B", key: "b", ch: "b", shiftCh: "B" },
    { label: "N", key: "n", ch: "n", shiftCh: "N" },
    { label: "M", key: "m", ch: "m", shiftCh: "M" },
    { label: ",", shiftLabel: "<", key: "comma", ch: ",", shiftCh: "<", dual: true },
    { label: ".", shiftLabel: ">", key: "dot", ch: ".", shiftCh: ">", dual: true },
    { label: "/", shiftLabel: "?", key: "slash", ch: "/", shiftCh: "?", dual: true },
    { label: "Shift", key: "shift", wide: "shift", cls: "mod a500-shift" },
  ],
  [
    { label: "Alt", key: "alt", wide: "alt", cls: "mod" },
    { label: "A", key: "amiga", wide: "amiga", cls: "mod a500-amiga" },
    { label: "", key: "space", wide: "space", cls: "space" },
    { label: "A", key: "ramiga", wide: "amiga", cls: "mod a500-amiga" },
    { label: "Alt", key: "alt", wide: "alt", cls: "mod" },
    { label: "←", key: "left", cls: "arrow a500-cleft" },
    { label: "↓", key: "down", cls: "arrow a500-cdown" },
    { label: "↑", key: "up", cls: "arrow a500-cup" },
    { label: "→", key: "right", cls: "arrow a500-cright" },
  ],
];

/** Modern PC-style generic keyboard (F1–F12, no Amiga keys). */
const GENERIC_ROWS: KeyDef[][] = [
  [
    { label: "Esc", key: "esc", cls: "fn", wide: "wide" },
    { label: "F1", key: "f1", cls: "fn" },
    { label: "F2", key: "f2", cls: "fn" },
    { label: "F3", key: "f3", cls: "fn" },
    { label: "F4", key: "f4", cls: "fn" },
    { label: "F5", key: "f5", cls: "fn" },
    { label: "F6", key: "f6", cls: "fn" },
    { label: "F7", key: "f7", cls: "fn" },
    { label: "F8", key: "f8", cls: "fn" },
    { label: "F9", key: "f9", cls: "fn" },
    { label: "F10", key: "f10", cls: "fn" },
    { label: "F11", key: "f11", cls: "fn" },
    { label: "F12", key: "f12", cls: "fn" },
  ],
  [
    { label: "`", shiftLabel: "~", key: "grave", ch: "`", shiftCh: "~", dual: true },
    { label: "1", shiftLabel: "!", key: "1", ch: "1", shiftCh: "!", dual: true },
    { label: "2", shiftLabel: "@", key: "2", ch: "2", shiftCh: "@", dual: true },
    { label: "3", shiftLabel: "#", key: "3", ch: "3", shiftCh: "#", dual: true },
    { label: "4", shiftLabel: "$", key: "4", ch: "4", shiftCh: "$", dual: true },
    { label: "5", shiftLabel: "%", key: "5", ch: "5", shiftCh: "%", dual: true },
    { label: "6", shiftLabel: "^", key: "6", ch: "6", shiftCh: "^", dual: true },
    { label: "7", shiftLabel: "&", key: "7", ch: "7", shiftCh: "&", dual: true },
    { label: "8", shiftLabel: "*", key: "8", ch: "8", shiftCh: "*", dual: true },
    { label: "9", shiftLabel: "(", key: "9", ch: "9", shiftCh: "(", dual: true },
    { label: "0", shiftLabel: ")", key: "0", ch: "0", shiftCh: ")", dual: true },
    { label: "-", shiftLabel: "_", key: "minus", ch: "-", shiftCh: "_", dual: true },
    { label: "=", shiftLabel: "+", key: "equal", ch: "=", shiftCh: "+", dual: true },
    { label: "⌫", key: "backspace", wide: "wider", cls: "mod" },
  ],
  [
    { label: "Tab", key: "tab", wide: "tab", cls: "mod" },
    { label: "Q", key: "q", ch: "q", shiftCh: "Q" },
    { label: "W", key: "w", ch: "w", shiftCh: "W" },
    { label: "E", key: "e", ch: "e", shiftCh: "E" },
    { label: "R", key: "r", ch: "r", shiftCh: "R" },
    { label: "T", key: "t", ch: "t", shiftCh: "T" },
    { label: "Y", key: "y", ch: "y", shiftCh: "Y" },
    { label: "U", key: "u", ch: "u", shiftCh: "U" },
    { label: "I", key: "i", ch: "i", shiftCh: "I" },
    { label: "O", key: "o", ch: "o", shiftCh: "O" },
    { label: "P", key: "p", ch: "p", shiftCh: "P" },
    { label: "[", shiftLabel: "{", key: "lbrace", ch: "[", shiftCh: "{", dual: true },
    { label: "]", shiftLabel: "}", key: "rbrace", ch: "]", shiftCh: "}", dual: true },
    { label: "\\", shiftLabel: "|", key: "backslash", ch: "\\", shiftCh: "|", dual: true },
  ],
  [
    { label: "Caps", key: "caps", wide: "caps", cls: "mod" },
    { label: "A", key: "a", ch: "a", shiftCh: "A" },
    { label: "S", key: "s", ch: "s", shiftCh: "S" },
    { label: "D", key: "d", ch: "d", shiftCh: "D" },
    { label: "F", key: "f", ch: "f", shiftCh: "F" },
    { label: "G", key: "g", ch: "g", shiftCh: "G" },
    { label: "H", key: "h", ch: "h", shiftCh: "H" },
    { label: "J", key: "j", ch: "j", shiftCh: "J" },
    { label: "K", key: "k", ch: "k", shiftCh: "K" },
    { label: "L", key: "l", ch: "l", shiftCh: "L" },
    { label: ";", shiftLabel: ":", key: "semicolon", ch: ";", shiftCh: ":", dual: true },
    { label: "'", shiftLabel: '"', key: "apostrophe", ch: "'", shiftCh: '"', dual: true },
    { label: "Enter", key: "enter", wide: "wider", cls: "enter" },
  ],
  [
    { label: "Shift", key: "shift", wide: "shift", cls: "mod a500-shift gen-shift" },
    { label: "Z", key: "z", ch: "z", shiftCh: "Z" },
    { label: "X", key: "x", ch: "x", shiftCh: "X" },
    { label: "C", key: "c", ch: "c", shiftCh: "C" },
    { label: "V", key: "v", ch: "v", shiftCh: "V" },
    { label: "B", key: "b", ch: "b", shiftCh: "B" },
    { label: "N", key: "n", ch: "n", shiftCh: "N" },
    { label: "M", key: "m", ch: "m", shiftCh: "M" },
    { label: ",", shiftLabel: "<", key: "comma", ch: ",", shiftCh: "<", dual: true },
    { label: ".", shiftLabel: ">", key: "dot", ch: ".", shiftCh: ">", dual: true },
    { label: "/", shiftLabel: "?", key: "slash", ch: "/", shiftCh: "?", dual: true },
    { label: "Shift", key: "shift", wide: "shift", cls: "mod a500-shift gen-shift" },
  ],
  [
    { label: "Ctrl", key: "ctrl", wide: "ctrl", cls: "mod" },
    { label: "Alt", key: "alt", wide: "alt", cls: "mod" },
    { label: "Space", key: "space", wide: "space", cls: "space" },
    { label: "Alt", key: "alt", wide: "alt", cls: "mod" },
    { label: "←", key: "left", cls: "arrow" },
    { label: "↓", key: "down", cls: "arrow" },
    { label: "↑", key: "up", cls: "arrow" },
    { label: "→", key: "right", cls: "arrow" },
    { label: "Del", key: "delete", wide: "wide", cls: "mod" },
  ],
];

const SPECIAL_CHAR: Record<string, string> = {
  grave: "`",
  minus: "-",
  equal: "=",
  lbrace: "[",
  rbrace: "]",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  comma: ",",
  dot: ".",
  slash: "/",
};

function paintShiftLabels() {
  document.querySelectorAll<HTMLButtonElement>(".key[data-label]").forEach((btn) => {
    const base = btn.dataset.label || "";
    const sh = btn.dataset.shiftLabel;
    const dual = btn.classList.contains("dual");
    if (dual && sh) {
      const top = btn.querySelector(".key-legend-top");
      const bot = btn.querySelector(".key-legend-bot");
      if (top && bot) {
        // Stay dual; highlight which layer is active
        btn.classList.toggle("shift-layer", shiftOn);
        return;
      }
    }
    if (btn.querySelector(".key-face")) return; // custom face (Amiga badge etc.)
    btn.textContent = shiftOn && sh ? sh : base;
  });
  document.querySelectorAll<HTMLButtonElement>(".key.a500-shift").forEach((b) => {
    b.classList.toggle("on", shiftOn);
    b.setAttribute("aria-pressed", shiftOn ? "true" : "false");
  });
  document.querySelectorAll<HTMLButtonElement>(".key.caps, .key[data-key='caps']").forEach((b) => {
    b.classList.toggle("on", capsOn);
    b.setAttribute("aria-pressed", capsOn ? "true" : "false");
  });
  const shiftBtn = $("btn-shift");
  if (shiftBtn) {
    shiftBtn.setAttribute("aria-pressed", shiftOn ? "true" : "false");
    shiftBtn.classList.toggle("on", shiftOn);
  }
}

/** Queue keys so typing never waits on SSH round-trips one-by-one. */
type PendingKey = { key: string; shift: boolean };
let keyQ: PendingKey[] = [];
let keyFlushing = false;

function enqueueKey(key: string, shift = false) {
  if (!settings) {
    status("No settings — reopen mouse window");
    return;
  }
  // Immediate short feedback so long SSH tips don't linger and confuse
  const show = key.length === 1 ? key : key;
  status(`Sending “${show}”…`);
  keyQ.push({ key, shift });
  // Cap queue so a stuck TV can't pile up forever
  if (keyQ.length > 64) keyQ.splice(0, keyQ.length - 64);
  void flushKeyQueue();
}

async function flushKeyQueue() {
  if (keyFlushing || !settings) return;
  keyFlushing = true;
  try {
    while (keyQ.length && settings) {
      // One key / short burst at a time — avoid multi-char type_text tips on single taps
      const first = keyQ[0];
      if (first.key.length === 1 && !first.shift) {
        let text = "";
        while (
          keyQ.length &&
          keyQ[0].key.length === 1 &&
          !keyQ[0].shift &&
          text.length < 8
        ) {
          text += keyQ.shift()!.key;
        }
        try {
          // Prefer per-key inject so status stays short and reliable
          if (text.length === 1) {
            const r = await invoke<string>("ra_keyboard_key", {
              settings,
              key: text,
              shift: false,
            });
            const raNo = /ra=NO/i.test(r || "");
            status(
              raNo
                ? `Key “${text}” sent, but RetroArch is not running — Play Amiga first.`
                : `Key “${text}” → TV`,
            );
          } else {
            // Still one SSH type for a short burst of letters
            for (const ch of text) {
              await invoke<string>("ra_keyboard_key", {
                settings,
                key: ch,
                shift: false,
              });
            }
            status(`Keys “${text}” → TV`);
          }
        } catch (e) {
          status(`Key failed: ${String(e)}`);
        }
        continue;
      }
      const item = keyQ.shift()!;
      try {
        const r = await invoke<string>("ra_keyboard_key", {
          settings,
          key: item.key,
          shift: item.shift,
        });
        const raNo = /ra=NO/i.test(r || "");
        const label = item.key.length === 1 ? item.key : item.key;
        status(
          raNo
            ? `Key “${label}” sent, but RetroArch is not running — Play Amiga first.`
            : `Key “${label}” → TV`,
        );
      } catch (e) {
        status(`Key failed: ${String(e)}`);
      }
    }
  } finally {
    keyFlushing = false;
    if (keyQ.length) void flushKeyQueue();
  }
}

async function sendKbKey(def: KeyDef) {
  if (!settings) return;
  try {
    // Shift is a sticky toggle (handled in pointerdown) — don't re-send as a key
    if (def.key === "shift") return;

    // Caps Lock is sticky in the UI + one Capslock inject to the TV
    if (def.key === "caps" || def.key === "capslock") {
      capsOn = !capsOn;
      paintShiftLabels();
      enqueueKey("caps", false);
      status(
        capsOn
          ? "Caps Lock ON — press Caps again to turn off"
          : "Caps Lock OFF",
      );
      return;
    }

    if (def.ch || def.shiftCh) {
      // Prefer explicit shifted character when Shift is sticky
      let ch = shiftOn ? def.shiftCh || def.ch! : def.ch!;
      // Local caps (without Shift) uppercases letters for the Amiga
      if (!shiftOn && capsOn && ch.length === 1 && /[a-z]/i.test(ch)) {
        ch = ch.toUpperCase();
      }
      enqueueKey(ch, false);
      if (shiftOn) {
        shiftOn = false;
        paintShiftLabels();
      }
      return;
    }
    // Map ramiga → rightamiga for inject
    let key = def.key === "ramiga" ? "rightamiga" : def.key;
    if (SPECIAL_CHAR[key] && !shiftOn) {
      key = SPECIAL_CHAR[key];
    } else if (SPECIAL_CHAR[key] && shiftOn && def.shiftCh) {
      key = def.shiftCh;
    }
    enqueueKey(key, shiftOn && !def.ch);
    if (shiftOn && def.key !== "shift") {
      shiftOn = false;
      paintShiftLabels();
    }
  } catch (e) {
    status(String(e));
  }
}

function setKbMode(mode: KbMode) {
  kbMode = mode;
  saveKbMode(mode);
  document.querySelectorAll<HTMLButtonElement>("[data-kb-mode]").forEach((b) => {
    const on = b.dataset.kbMode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  const col = document.querySelector(".kb-col");
  col?.classList.toggle("mode-a500", mode === "a500");
  col?.classList.toggle("mode-generic", mode === "generic");
  buildKeyboard();
  paintShiftLabels();
}

function buildKeyboard() {
  const root = $("kb");
  root.innerHTML = "";
  root.className = "kb";
  root.classList.toggle("a500-kb", kbMode === "a500");
  root.classList.toggle("generic-kb", kbMode === "generic");
  root.setAttribute(
    "aria-label",
    kbMode === "a500" ? "Amiga 500 virtual keyboard" : "Generic PC virtual keyboard",
  );

  if (kbMode === "a500") {
    const badge = document.createElement("div");
    badge.className = "a500-badge";
    badge.innerHTML =
      '<div class="a500-badge-left">' +
      '<span class="a500-badge-mark" aria-hidden="true">A</span>' +
      '<span class="a500-badge-text"><strong>Amiga</strong><span class="a500-badge-sub">500</span></span>' +
      "</div>" +
      '<div class="a500-badge-right" aria-hidden="true">' +
      '<span class="a500-led" title="Power"></span>' +
      '<span class="a500-led-label">Power</span>' +
      "</div>";
    root.appendChild(badge);
  } else {
    const badge = document.createElement("div");
    badge.className = "generic-badge";
    badge.innerHTML =
      '<span class="generic-badge-text">Generic keyboard</span>' +
      '<span class="generic-badge-hint">PC layout · F1–F12</span>';
    root.appendChild(badge);
  }

  const well = document.createElement("div");
  well.className = kbMode === "a500" ? "a500-well" : "generic-well";
  root.appendChild(well);

  const rows = kbMode === "a500" ? A500_ROWS : GENERIC_ROWS;
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";
    for (const def of row) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "key";
      if (def.wide) btn.classList.add(def.wide);
      if (def.cls) def.cls.split(/\s+/).forEach((c) => btn.classList.add(c));
      if (def.dual && def.shiftLabel) btn.classList.add("dual");
      btn.dataset.label = def.label;
      if (def.shiftLabel) btn.dataset.shiftLabel = def.shiftLabel;
      btn.dataset.key = def.key;

      if (def.key === "amiga" || def.key === "ramiga") {
        btn.innerHTML =
          '<span class="key-face amiga-face" aria-hidden="true">' +
          '<span class="amiga-a">A</span></span>';
        btn.title = def.key === "amiga" ? "Left Amiga" : "Right Amiga";
        btn.setAttribute(
          "aria-label",
          def.key === "amiga" ? "Left Amiga key" : "Right Amiga key",
        );
      } else if (def.key === "space" && kbMode === "a500") {
        btn.innerHTML = '<span class="space-bar-face" aria-hidden="true"></span>';
        btn.title = "Space";
        btn.setAttribute("aria-label", "Space");
      } else if (def.dual && def.shiftLabel) {
        btn.innerHTML =
          `<span class="key-legend-top">${escapeKb(def.shiftLabel)}</span>` +
          `<span class="key-legend-bot">${escapeKb(def.label)}</span>`;
        btn.title = `${def.label}  /  ${def.shiftLabel}`;
      } else if (def.cls?.includes("multilabel") || def.label.includes("\n")) {
        const parts = def.label.split("\n");
        btn.innerHTML = parts
          .map((p) => `<span class="key-line">${escapeKb(p)}</span>`)
          .join("");
        btn.title = def.label.replace("\n", " ");
      } else {
        btn.textContent = def.label;
        btn.title = def.key === "help" ? "Help" : def.key;
      }

      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        btn.classList.add("pressed");
        if (def.key === "shift") {
          shiftOn = !shiftOn;
          paintShiftLabels();
          status(
            shiftOn
              ? "Shift ON — next key is shifted (press Shift again to cancel)"
              : "Shift OFF",
          );
          return;
        }
        void sendKbKey(def);
      });
      const clear = () => btn.classList.remove("pressed");
      btn.addEventListener("pointerup", clear);
      btn.addEventListener("pointercancel", clear);
      btn.addEventListener("pointerleave", clear);
      rowEl.appendChild(btn);
    }
    well.appendChild(rowEl);
  }

  if (kbMode === "a500") {
    const feet = document.createElement("div");
    feet.className = "a500-feet";
    feet.setAttribute("aria-hidden", "true");
    feet.innerHTML = '<span class="a500-foot"></span><span class="a500-foot"></span>';
    root.appendChild(feet);
  }
}

function escapeKb(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a whole line the same way Return works: one SSH key inject per character.
 * Batch type-text paths were unreliable on webOS (hello → nothing / only last letter).
 */
async function sendText() {
  if (!settings) return;
  const text = $input("type-input").value;
  if (!text) {
    status("Nothing to send — type a line, then press Send (or Enter).");
    return;
  }
  const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  status(
    `Sending “${preview}” one key at a time (${text.length} keys)…\n` +
      `Amiga must be Playing with a text field focused.`,
  );

  let ok = 0;
  let fail = 0;
  let raNo = false;
  try {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r") continue;
      const key = ch === "\n" ? "enter" : ch;
      try {
        const r = await invoke<string>("ra_keyboard_key", {
          settings,
          key,
          shift: false,
        });
        ok += 1;
        if (/ra=NO/i.test(r || "")) raNo = true;
        status(
          `Sending “${preview}”… ${ok}/${text.length}  (just sent “${key === " " ? "space" : key}”)`,
        );
      } catch (e) {
        fail += 1;
        status(`Failed on “${key}”: ${String(e)}`);
        // keep going so partial words still arrive
      }
      // Wait for PUAE to accept each key (Return-sized gap between letters)
      await sleepMs(320);
    }
    if (raNo) {
      status(
        `Sent ${ok} key(s), fail ${fail} — but RetroArch may not be running.\n` +
          `→ Play an Amiga disk, click the text field, Send again.`,
      );
    } else if (ok === 0) {
      status(`Nothing was sent (fail ${fail}). Check network / SSH.`);
    } else {
      status(
        `Done: sent “${preview}” (${ok} keys${fail ? `, ${fail} failed` : ""}).\n` +
          `If the Amiga is blank: click the text field, then Send again.`,
      );
    }
  } catch (e) {
    status(`Type failed: ${String(e)}`);
  }
}

/* ── Init ────────────────────────────────────────────────── */

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  settings = await loadSettings();
  $("target-label").textContent = "mouse + keyboard → TV";
  // Default game mode: no system cursor (showing it pauses RetroArch audio on webOS)
  mouseMode = "game";
  status(
    "Ready — smooth mouse · Speed slider · Shift = fine aim · double-click pad to warp",
  );

  kbMode = loadKbMode();
  document.querySelectorAll<HTMLButtonElement>("[data-kb-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      const m = b.dataset.kbMode;
      if (m === "a500" || m === "generic") setKbMode(m);
    });
  });
  setKbMode(kbMode);

  const pad = $("pad");
  const cursor = $("pad-cursor");
  const speedEl = $input("speed");
  const speedVal = $("speed-val");
  // Wider range 1-10; default 5 (controllable — raise slider if you want faster)
  speedEl.min = "1";
  speedEl.max = "10";
  try {
    const tune = localStorage.getItem(SPEED_TUNE_KEY);
    const saved = localStorage.getItem(SPEED_KEY);
    const n = saved != null ? Number(saved) : NaN;
    if (tune !== SPEED_TUNE_VER) {
      // One-time reset after jumpy high-gain builds
      speedEl.value = "5";
      localStorage.setItem(SPEED_KEY, "5");
      localStorage.setItem(SPEED_TUNE_KEY, SPEED_TUNE_VER);
    } else if (Number.isFinite(n) && n >= 1 && n <= 10) {
      speedEl.value = String(n);
    } else {
      speedEl.value = "5";
    }
  } catch {
    speedEl.value = "5";
  }
  speedVal.textContent = speedEl.value;
  speedEl.addEventListener("input", () => {
    speedVal.textContent = speedEl.value;
    try {
      localStorage.setItem(SPEED_KEY, speedEl.value);
    } catch {
      /* ignore */
    }
  });

  /**
   * Virtual TV pointer in screen space. The pad is a mini map of the TV:
   * the glyph is drawn at the same relative position we believe the TV cursor
   * is at. We can't read absolute position from webOS, so we integrate the
   * same REL deltas we send over SSH (1:1 with the TV).
   */
  const TV_W = 1920;
  const TV_H = 1080;
  let tvX = TV_W / 2;
  let tvY = TV_H / 2;
  let padW = 0;
  let padH = 0;

  function measurePad() {
    const r = pad.getBoundingClientRect();
    padW = r.width;
    padH = r.height;
  }

  function paintCursorFromTv() {
    measurePad();
    // Map TV coords → pad pixels (tip of arrow ~ hot-spot at 0,0 of glyph)
    const cx = (tvX / TV_W) * Math.max(1, padW - 4);
    const cy = (tvY / TV_H) * Math.max(1, padH - 4);
    cursor.style.setProperty("--cx", `${cx}px`);
    cursor.style.setProperty("--cy", `${cy}px`);
  }

  function clampTv(x: number, y: number) {
    return {
      x: Math.max(0, Math.min(TV_W, x)),
      y: Math.max(0, Math.min(TV_H, y)),
    };
  }

  /** Apply a TV-space delta to our model + paint pad (call with same values as queueMove). */
  function applyTvDelta(dx: number, dy: number) {
    const c = clampTv(tvX + dx, tvY + dy);
    tvX = c.x;
    tvY = c.y;
    paintCursorFromTv();
  }

  function centerCursor() {
    tvX = TV_W / 2;
    tvY = TV_H / 2;
    paintCursorFromTv();
  }

  /** Warp model + send REL to TV so pad position matches a click on the mini-map. */
  async function warpToPadPoint(clientX: number, clientY: number) {
    measurePad();
    const rect = pad.getBoundingClientRect();
    const lx = Math.max(0, Math.min(padW, clientX - rect.left));
    const ly = Math.max(0, Math.min(padH, clientY - rect.top));
    const targetX = (lx / Math.max(1, padW)) * TV_W;
    const targetY = (ly / Math.max(1, padH)) * TV_H;
    let ddx = targetX - tvX;
    let ddy = targetY - tvY;
    tvX = targetX;
    tvY = targetY;
    paintCursorFromTv();
    // Send in chunks (fast path clamps ~±1400)
    while (Math.abs(ddx) > 0.5 || Math.abs(ddy) > 0.5) {
      const sx = Math.max(-400, Math.min(400, Math.round(ddx)));
      const sy = Math.max(-400, Math.min(400, Math.round(ddy)));
      if (sx === 0 && sy === 0) break;
      ddx -= sx;
      ddy -= sy;
      queueMove(sx, sy);
      await yieldToUiMouse();
    }
    void flushMove();
  }

  function yieldToUiMouse(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  centerCursor();
  window.addEventListener("resize", () => {
    paintCursorFromTv();
  });

  let dragging = false;
  let activePointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let leftHeld = false;
  let downT = 0;
  let downX = 0;
  let downY = 0;
  let movedDist = 0;

  const flashClick = (side: "left" | "right") => {
    cursor.classList.remove("clicking", "right-clicking");
    void cursor.offsetWidth;
    cursor.classList.add(side === "left" ? "clicking" : "right-clicking");
    window.setTimeout(() => {
      cursor.classList.remove("clicking", "right-clicking");
    }, 160);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      pad.classList.add("has-moved");
      $("pad-hint").textContent = "";
      flashClick("right");
      void click("right");
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    e.preventDefault();
    dragging = true;
    activePointerId = e.pointerId;
    movedDist = 0;
    downT = performance.now();
    downX = e.clientX;
    downY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    pad.classList.add("dragging", "has-moved");
    $("pad-hint").textContent = "";
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (e.shiftKey) {
      leftHeld = true;
      cursor.classList.add("clicking");
      void button("down", "left");
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || activePointerId !== e.pointerId) return;

    let rawDx = e.movementX;
    let rawDy = e.movementY;
    if (rawDx === 0 && rawDy === 0) {
      rawDx = e.clientX - lastX;
      rawDy = e.clientY - lastY;
    }
    lastX = e.clientX;
    lastY = e.clientY;

    if (rawDx === 0 && rawDy === 0) return;

    // Ignore only tiny sensor noise (keep small moves so aim stays easy)
    const mag = Math.hypot(rawDx, rawDy);
    if (mag < 0.35) return;

    movedDist += mag;

    // Shift held during drag = precision (also used for drag-to-hold LMB)
    const precision = e.shiftKey && !leftHeld;
    const mapped = mapPadToTv(rawDx, rawDy, precision);
    // Pad glyph tracks the same TV-space deltas we inject (not raw pad pixels)
    applyTvDelta(mapped.dx, mapped.dy);
    queueMove(mapped.dx, mapped.dy);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) {
      return;
    }
    dragging = false;
    activePointerId = null;
    pad.classList.remove("dragging");
    flushMove();
    if (leftHeld) {
      leftHeld = false;
      cursor.classList.remove("clicking");
      void button("up", "left");
    }
    try {
      pad.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (e.button === 0 || e.pointerType !== "mouse") {
      const dt = performance.now() - downT;
      const dist = Math.max(
        movedDist,
        Math.hypot(e.clientX - downX, e.clientY - downY),
      );
      if (dt < 280 && dist < 10) {
        // Short tap = left click at current TV position (no warp — keeps aim)
        flashClick("left");
        void click("left");
      }
    }
  };

  // Double-click the pad: warp TV pointer to that mini-map position (re-sync)
  let lastTapT = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  pad.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const now = performance.now();
    const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
    if (now - lastTapT < 320 && dist < 28) {
      pad.classList.add("has-moved");
      $("pad-hint").textContent = "";
      status("Warp → TV position (pad is a mini-map of the screen)");
      void warpToPadPoint(e.clientX, e.clientY);
      lastTapT = 0;
    } else {
      lastTapT = now;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
    }
  });

  pad.addEventListener("pointerdown", onPointerDown);
  pad.addEventListener("pointermove", onPointerMove);
  pad.addEventListener("pointerup", onPointerUp);
  pad.addEventListener("pointercancel", onPointerUp);
  pad.addEventListener("lostpointercapture", () => {
    if (dragging) {
      dragging = false;
      activePointerId = null;
      pad.classList.remove("dragging");
      flushMove();
    }
  });
  pad.addEventListener("contextmenu", (e) => e.preventDefault());

  // LMB / RMB buttons
  for (const [id, side] of [
    ["btn-left", "left"],
    ["btn-right", "right"],
  ] as const) {
    const el = $(id);
    let held = false;
    let isHold = false;
    let holdTimer: number | null = null;
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      held = true;
      isHold = false;
      el.classList.add("pressed");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (holdTimer != null) window.clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        if (!held) return;
        isHold = true;
        void button("down", side);
        status(`${side} hold`);
      }, 220);
    });
    const release = (e?: PointerEvent) => {
      if (!held) return;
      held = false;
      el.classList.remove("pressed");
      if (holdTimer != null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (isHold) {
        isHold = false;
        void button("up", side);
        status(`${side} up`);
      } else {
        flashClick(side);
        void click(side);
      }
      if (e) {
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };
    el.addEventListener("pointerup", (e) => release(e));
    el.addEventListener("pointercancel", (e) => release(e));
    el.addEventListener("lostpointercapture", () => {
      if (held) release();
    });
  }

  document.querySelectorAll<HTMLButtonElement>("[data-nudge]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [dx, dy] = (btn.dataset.nudge || "0,0").split(",").map(Number);
      // Nudges: larger fixed steps so arrow/nudge buttons feel useful
      const g = speedGain(speed());
      const rdx = Math.round((dx / 40) * 18 * g);
      const rdy = Math.round((dy / 40) * 18 * g);
      const sx = rdx === 0 && dx !== 0 ? (dx > 0 ? 1 : -1) : rdx;
      const sy = rdy === 0 && dy !== 0 ? (dy > 0 ? 1 : -1) : rdy;
      applyTvDelta(sx, sy);
      pad.classList.add("has-moved");
      $("pad-hint").textContent = "";
      queueMove(sx, sy);
      status(`nudge ${sx},${sy}`);
    });
  });

  $("btn-show-cursor").addEventListener("click", (e) => {
    e.preventDefault();
    void toggleSystemCursorMode();
  });

  const wireKeyBtn = (id: string, key: "esc" | "enter") => {
    const el = $(id);
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.classList.add("pressed");
    });
    const done = () => el.classList.remove("pressed");
    el.addEventListener("pointerup", (e) => {
      e.preventDefault();
      done();
      void sendNamedKey(key);
    });
    el.addEventListener("pointercancel", done);
    el.addEventListener("click", (e) => e.preventDefault());
  };
  wireKeyBtn("btn-esc", "esc");
  wireKeyBtn("btn-enter", "enter");

  // Shift + text row
  $("btn-shift").addEventListener("click", () => {
    shiftOn = !shiftOn;
    paintShiftLabels();
    status(
      shiftOn
        ? "Shift ON — next key is shifted (press Shift again to cancel)"
        : "Shift OFF",
    );
  });
  $("btn-send-text").addEventListener("click", () => void sendText());
  $("btn-clear-text").addEventListener("click", () => {
    $input("type-input").value = "";
    $input("type-input").focus();
  });

  const typeInput = $input("type-input");
  typeInput.addEventListener("focus", () => {
    ignorePhysical = true;
  });
  typeInput.addEventListener("blur", () => {
    ignorePhysical = false;
  });
  typeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  });

  // Physical laptop keys when not typing in the text field
  window.addEventListener("keydown", (e) => {
    if (ignorePhysical) return;
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Mouse shortcuts that shouldn't also type to the TV
    if (e.code === "Space") {
      e.preventDefault();
      flashClick("left");
      void click("left");
      return;
    }

    const s = speed() * 12;
    if (e.key === "ArrowUp" && e.shiftKey) {
      e.preventDefault();
      applyTvDelta(0, -s);
      queueMove(0, -s);
      return;
    }
    if (e.key === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      applyTvDelta(0, s);
      queueMove(0, s);
      return;
    }
    if (e.key === "ArrowLeft" && e.shiftKey) {
      e.preventDefault();
      applyTvDelta(-s, 0);
      queueMove(-s, 0);
      return;
    }
    if (e.key === "ArrowRight" && e.shiftKey) {
      e.preventDefault();
      applyTvDelta(s, 0);
      queueMove(s, 0);
      return;
    }

    if (e.key === "Shift") {
      shiftOn = true;
      paintShiftLabels();
      return;
    }

    const mapNamed: Record<string, string> = {
      Escape: "esc",
      Enter: "enter",
      Backspace: "backspace",
      Tab: "tab",
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Delete: "delete",
      F1: "f1",
      F2: "f2",
      F3: "f3",
      F4: "f4",
      F5: "f5",
      F6: "f6",
      F7: "f7",
      F8: "f8",
      F9: "f9",
      F10: "f10",
      F11: "f11",
      F12: "f12",
    };

    e.preventDefault();

    if (mapNamed[e.key]) {
      if (e.key === "Escape") {
        $("btn-esc").classList.add("pressed");
        window.setTimeout(() => $("btn-esc").classList.remove("pressed"), 120);
      }
      if (e.key === "Enter") {
        $("btn-enter").classList.add("pressed");
        window.setTimeout(() => $("btn-enter").classList.remove("pressed"), 120);
      }
      enqueueKey(mapNamed[e.key], e.shiftKey);
      return;
    }

    if (e.key.length === 1) {
      enqueueKey(e.key, false);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && !ignorePhysical) {
      shiftOn = false;
      paintShiftLabels();
    }
  });

  status(
    "Ready — drag pad to move (accel · Shift = precision) · LMB/RMB · Space = click · Shift+arrows = nudge",
  );
});
