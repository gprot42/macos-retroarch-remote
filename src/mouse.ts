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
  wide?: "wide" | "wider" | "space";
  cls?: string;
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
let pendingDx = 0;
let pendingDy = 0;
let flushTimer: number | null = null;
let lastFlush = 0;
let shiftOn = false;
/** When true, physical keys go to the type-input, not the TV */
let ignorePhysical = false;

function speed(): number {
  return Number($input("speed").value) || 3;
}

async function sendMove(dx: number, dy: number) {
  if (!settings) return;
  if (dx === 0 && dy === 0) return;
  try {
    await invoke("ra_mouse_move", { settings, dx, dy });
  } catch (e) {
    status(String(e));
  }
}

function queueMove(dx: number, dy: number) {
  pendingDx += dx;
  pendingDy += dy;
  const now = performance.now();
  if (now - lastFlush < 40) {
    if (flushTimer == null) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushMove();
      }, 40);
    }
    return;
  }
  flushMove();
}

function flushMove() {
  const dx = Math.round(pendingDx);
  const dy = Math.round(pendingDy);
  pendingDx = 0;
  pendingDy = 0;
  lastFlush = performance.now();
  if (dx !== 0 || dy !== 0) void sendMove(dx, dy);
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
  if (!settings || busy) return;
  busy = true;
  try {
    const r = await invoke<string>("ra_key", { settings, key });
    status(r.trim());
  } catch (e) {
    status(String(e));
  } finally {
    busy = false;
  }
}

async function showCursor() {
  if (!settings) return;
  try {
    const r = await invoke<string>("ra_show_cursor", { settings });
    status(r.trim() || "cursor shown");
  } catch (e) {
    status(String(e));
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

/* ── Virtual keyboard layout ─────────────────────────────── */

const ROWS: KeyDef[][] = [
  [
    { label: "Esc", key: "esc", cls: "fn wide" },
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
    { label: "`", shiftLabel: "~", key: "grave", ch: "`", shiftCh: "~" },
    { label: "1", shiftLabel: "!", key: "1", ch: "1", shiftCh: "!" },
    { label: "2", shiftLabel: "@", key: "2", ch: "2", shiftCh: "@" },
    { label: "3", shiftLabel: "#", key: "3", ch: "3", shiftCh: "#" },
    { label: "4", shiftLabel: "$", key: "4", ch: "4", shiftCh: "$" },
    { label: "5", shiftLabel: "%", key: "5", ch: "5", shiftCh: "%" },
    { label: "6", shiftLabel: "^", key: "6", ch: "6", shiftCh: "^" },
    { label: "7", shiftLabel: "&", key: "7", ch: "7", shiftCh: "&" },
    { label: "8", shiftLabel: "*", key: "8", ch: "8", shiftCh: "*" },
    { label: "9", shiftLabel: "(", key: "9", ch: "9", shiftCh: "(" },
    { label: "0", shiftLabel: ")", key: "0", ch: "0", shiftCh: ")" },
    { label: "-", shiftLabel: "_", key: "minus", ch: "-", shiftCh: "_" },
    { label: "=", shiftLabel: "+", key: "equal", ch: "=", shiftCh: "+" },
    { label: "⌫", key: "backspace", wide: "wider", cls: "wide" },
  ],
  [
    { label: "Tab", key: "tab", wide: "wide" },
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
    { label: "[", shiftLabel: "{", key: "lbrace", ch: "[", shiftCh: "{" },
    { label: "]", shiftLabel: "}", key: "rbrace", ch: "]", shiftCh: "}" },
    { label: "\\", shiftLabel: "|", key: "backslash", ch: "\\", shiftCh: "|" },
  ],
  [
    { label: "Caps", key: "caps", wide: "wider" },
    { label: "A", key: "a", ch: "a", shiftCh: "A" },
    { label: "S", key: "s", ch: "s", shiftCh: "S" },
    { label: "D", key: "d", ch: "d", shiftCh: "D" },
    { label: "F", key: "f", ch: "f", shiftCh: "F" },
    { label: "G", key: "g", ch: "g", shiftCh: "G" },
    { label: "H", key: "h", ch: "h", shiftCh: "H" },
    { label: "J", key: "j", ch: "j", shiftCh: "J" },
    { label: "K", key: "k", ch: "k", shiftCh: "K" },
    { label: "L", key: "l", ch: "l", shiftCh: "L" },
    { label: ";", shiftLabel: ":", key: "semicolon", ch: ";", shiftCh: ":" },
    { label: "'", shiftLabel: '"', key: "apostrophe", ch: "'", shiftCh: '"' },
    { label: "Enter ↵", key: "enter", wide: "wider", cls: "enter" },
  ],
  [
    { label: "Z", key: "z", ch: "z", shiftCh: "Z" },
    { label: "X", key: "x", ch: "x", shiftCh: "X" },
    { label: "C", key: "c", ch: "c", shiftCh: "C" },
    { label: "V", key: "v", ch: "v", shiftCh: "V" },
    { label: "B", key: "b", ch: "b", shiftCh: "B" },
    { label: "N", key: "n", ch: "n", shiftCh: "N" },
    { label: "M", key: "m", ch: "m", shiftCh: "M" },
    { label: ",", shiftLabel: "<", key: "comma", ch: ",", shiftCh: "<" },
    { label: ".", shiftLabel: ">", key: "dot", ch: ".", shiftCh: ">" },
    { label: "/", shiftLabel: "?", key: "slash", ch: "/", shiftCh: "?" },
    { label: "↑", key: "up" },
  ],
  [
    { label: "Space", key: "space", wide: "space", cls: "space" },
    { label: "←", key: "left" },
    { label: "↓", key: "down" },
    { label: "→", key: "right" },
    { label: "Del", key: "delete", wide: "wide" },
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
    btn.textContent = shiftOn && sh ? sh : base;
  });
  const shiftBtn = $("btn-shift");
  shiftBtn.setAttribute("aria-pressed", shiftOn ? "true" : "false");
  shiftBtn.classList.toggle("on", shiftOn);
}

async function sendKbKey(def: KeyDef) {
  if (!settings) return;
  try {
    if (def.ch || def.shiftCh) {
      const ch = shiftOn ? def.shiftCh || def.ch! : def.ch!;
      const r = await invoke<string>("ra_keyboard_key", {
        settings,
        key: ch,
        shift: false,
      });
      status(r.trim());
      if (shiftOn && def.ch) {
        shiftOn = false;
        paintShiftLabels();
      }
      return;
    }
    let key = def.key;
    if (SPECIAL_CHAR[key] && !shiftOn) {
      key = SPECIAL_CHAR[key];
    } else if (SPECIAL_CHAR[key] && shiftOn && def.shiftCh) {
      key = def.shiftCh;
    }
    const r = await invoke<string>("ra_keyboard_key", {
      settings,
      key,
      shift: shiftOn && !def.ch,
    });
    status(r.trim());
    if (shiftOn && def.key !== "shift") {
      shiftOn = false;
      paintShiftLabels();
    }
  } catch (e) {
    status(String(e));
  }
}

function buildKeyboard() {
  const root = $("kb");
  root.innerHTML = "";
  for (const row of ROWS) {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";
    for (const def of row) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "key";
      if (def.wide) btn.classList.add(def.wide);
      if (def.cls) def.cls.split(/\s+/).forEach((c) => btn.classList.add(c));
      btn.dataset.label = def.label;
      if (def.shiftLabel) btn.dataset.shiftLabel = def.shiftLabel;
      btn.dataset.key = def.key;
      btn.textContent = def.label;
      btn.title = def.key;
      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        btn.classList.add("pressed");
        void sendKbKey(def);
      });
      const clear = () => btn.classList.remove("pressed");
      btn.addEventListener("pointerup", clear);
      btn.addEventListener("pointercancel", clear);
      btn.addEventListener("pointerleave", clear);
      rowEl.appendChild(btn);
    }
    root.appendChild(rowEl);
  }
}

async function sendText() {
  if (!settings) return;
  const text = $input("type-input").value;
  if (!text) {
    status("Nothing to send.");
    return;
  }
  try {
    const r = await invoke<string>("ra_type_text", { settings, text });
    status(r.trim());
  } catch (e) {
    status(String(e));
  }
}

/* ── Init ────────────────────────────────────────────────── */

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  settings = await loadSettings();
  $("target-label").textContent = `${settings.user}@${settings.host} · mouse + keyboard`;

  buildKeyboard();

  const pad = $("pad");
  const cursor = $("pad-cursor");
  const speedEl = $input("speed");
  const speedVal = $("speed-val");
  speedEl.addEventListener("input", () => {
    speedVal.textContent = speedEl.value;
  });

  let cursorX = 0;
  let cursorY = 0;
  let padW = 0;
  let padH = 0;

  function measurePad() {
    const r = pad.getBoundingClientRect();
    padW = r.width;
    padH = r.height;
  }

  function paintCursor() {
    cursor.style.setProperty("--cx", `${cursorX}px`);
    cursor.style.setProperty("--cy", `${cursorY}px`);
  }

  function clampCursor(x: number, y: number) {
    measurePad();
    const margin = 2;
    const maxX = Math.max(margin, padW - 18);
    const maxY = Math.max(margin, padH - 18);
    return {
      x: Math.max(margin, Math.min(maxX, x)),
      y: Math.max(margin, Math.min(maxY, y)),
    };
  }

  function placeCursor(x: number, y: number) {
    const c = clampCursor(x, y);
    cursorX = c.x;
    cursorY = c.y;
    paintCursor();
  }

  function moveCursorBy(dx: number, dy: number) {
    placeCursor(cursorX + dx, cursorY + dy);
  }

  function centerCursor() {
    measurePad();
    placeCursor(padW / 2 - 4, padH / 2 - 4);
  }

  centerCursor();
  window.addEventListener("resize", () => {
    measurePad();
    placeCursor(cursorX, cursorY);
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

    movedDist += Math.hypot(rawDx, rawDy);
    moveCursorBy(rawDx, rawDy);

    const s = speed();
    queueMove(rawDx * s, rawDy * s);
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
        flashClick("left");
        void click("left");
      }
    }
  };

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

  const nudgeLocal = (dx: number, dy: number) => {
    moveCursorBy(dx * 0.4, dy * 0.4);
    pad.classList.add("has-moved");
    $("pad-hint").textContent = "";
  };

  document.querySelectorAll<HTMLButtonElement>("[data-nudge]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [dx, dy] = (btn.dataset.nudge || "0,0").split(",").map(Number);
      const s = speed();
      const rdx = Math.round(dx * s);
      const rdy = Math.round(dy * s);
      nudgeLocal(rdx, rdy);
      void sendMove(rdx, rdy);
      status(`nudge ${rdx},${rdy}`);
    });
  });

  $("btn-show-cursor").addEventListener("click", (e) => {
    e.preventDefault();
    void showCursor();
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

  void showCursor();

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
      nudgeLocal(0, -s);
      void sendMove(0, -s);
      return;
    }
    if (e.key === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      nudgeLocal(0, s);
      void sendMove(0, s);
      return;
    }
    if (e.key === "ArrowLeft" && e.shiftKey) {
      e.preventDefault();
      nudgeLocal(-s, 0);
      void sendMove(-s, 0);
      return;
    }
    if (e.key === "ArrowRight" && e.shiftKey) {
      e.preventDefault();
      nudgeLocal(s, 0);
      void sendMove(s, 0);
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
      void invoke("ra_keyboard_key", {
        settings,
        key: mapNamed[e.key],
        shift: e.shiftKey,
      })
        .then((r) => status(String(r).trim()))
        .catch((err) => status(String(err)));
      return;
    }

    if (e.key.length === 1) {
      void invoke("ra_keyboard_key", {
        settings,
        key: e.key,
        shift: false,
      })
        .then((r) => status(String(r).trim()))
        .catch((err) => status(String(err)));
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && !ignorePhysical) {
      shiftOn = false;
      paintShiftLabels();
    }
  });

  status(
    "Ready — pad + LMB/RMB · virtual keyboard · Space = left click · Shift+arrows = nudge",
  );
});
