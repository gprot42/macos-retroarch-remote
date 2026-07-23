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

type VolumeState = { volume: number | null; muted: boolean };

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

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
let vol: VolumeState = { volume: null, muted: false };
let pollTimer: number | null = null;
/** Skip poll overwriting UI while a step is in flight. */
let stepBusy = false;

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

function paintVolume() {
  const el = $("vol-value");
  const badge = $("vol-muted");
  const display = $("vol-display");
  if (vol.volume == null) {
    el.textContent = "—";
  } else {
    el.textContent = String(vol.volume);
  }
  display.classList.toggle("is-muted", vol.muted);
  badge.hidden = !vol.muted;
}

function parseVolumeJson(raw: string): VolumeState | null {
  try {
    const start = raw.lastIndexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      volume?: number | null;
      muted?: boolean;
    };
    const volume =
      typeof obj.volume === "number" && Number.isFinite(obj.volume)
        ? Math.max(0, Math.min(100, Math.round(obj.volume)))
        : null;
    return { volume, muted: !!obj.muted };
  } catch {
    return null;
  }
}

async function refreshVolume(opts?: { quiet?: boolean }) {
  if (!settings || stepBusy) return;
  try {
    const raw = await invoke<string>("ra_volume_get", { settings });
    const parsed = parseVolumeJson(raw);
    if (parsed) {
      vol = parsed;
      paintVolume();
      if (!opts?.quiet) {
        status(
          vol.muted
            ? `Muted · was ${vol.volume ?? "?"}`
            : `Volume ${vol.volume ?? "?"}`,
        );
      }
    }
  } catch (e) {
    if (!opts?.quiet) status(String(e));
  }
}

async function sendVolume(direction: "up" | "down") {
  if (!settings) return;
  // Optimistic UI while the TV round-trip runs
  if (vol.volume != null) {
    const delta = direction === "up" ? 1 : -1;
    vol = {
      volume: Math.max(0, Math.min(100, vol.volume + delta)),
      muted: false,
    };
    paintVolume();
  }
  stepBusy = true;
  try {
    // Uses sendSpecialKey + audio service (not pointer-socket VOLUMEUP — that
    // does not change level or show the on-TV volume OSD).
    const raw = await invoke<string>("ra_volume_step", {
      settings,
      direction,
      steps: 1,
    });
    const parsed = parseVolumeJson(raw);
    if (parsed) {
      vol = parsed;
      paintVolume();
      status(
        vol.muted
          ? `Muted · was ${vol.volume ?? "?"}`
          : `Volume ${vol.volume ?? "?"}`,
      );
    } else {
      status(raw.trim());
    }
  } catch (e) {
    status(String(e));
    // Re-sync if step failed
    void refreshVolume({ quiet: true });
  } finally {
    stepBusy = false;
  }
}

function startPolling() {
  if (pollTimer != null) window.clearInterval(pollTimer);
  void refreshVolume({ quiet: false });
  // Poll so physical Magic Remote changes show up here too
  pollTimer = window.setInterval(() => {
    void refreshVolume({ quiet: true });
  }, 1500);
}

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  settings = await loadSettings();
  $("target-label").textContent = "webOS TV";
  paintVolume();

  document.querySelectorAll<HTMLButtonElement>("[data-btn]").forEach((btn) => {
    const name = btn.dataset.btn!;
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      btn.classList.add("pressed");
      if (name === "VOLUMEUP") void sendVolume("up");
      else if (name === "VOLUMEDOWN") void sendVolume("down");
    });
    const clear = () => btn.classList.remove("pressed");
    btn.addEventListener("pointerup", clear);
    btn.addEventListener("pointercancel", clear);
    btn.addEventListener("pointerleave", clear);
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (
      e.code === "Equal" ||
      e.code === "NumpadAdd" ||
      e.key === "+" ||
      e.key === "="
    ) {
      e.preventDefault();
      void sendVolume("up");
      return;
    }
    if (
      e.code === "Minus" ||
      e.code === "NumpadSubtract" ||
      e.key === "-" ||
      e.key === "_"
    ) {
      e.preventDefault();
      void sendVolume("down");
    }
  });

  startPolling();
});
