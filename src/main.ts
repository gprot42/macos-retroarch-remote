import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

type Settings = {
  host: string;
  user: string;
  sshKey: string;
  port: number;
  scriptPath: string;
  sshExtra: string;
  /** TV paths */
  raDir: string;
  disksDir: string;
  systemDir: string;
  corePath: string;
};

const DEFAULT_RA =
  "/media/developer/apps/usr/palm/applications/com.retroarch.webos/.config/retroarch";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const $input = (id: string) => document.getElementById(id) as HTMLInputElement;

function log(msg: string, isError = false) {
  const el = $("log");
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}\n`;
  el.textContent = (el.textContent || "") + line;
  el.scrollTop = el.scrollHeight;
  if (isError) console.error(msg);
}

/** Normalize invoke / catch values into a readable string. */
function formatError(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.error === "string" && o.error.trim()) return o.error;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

/** First useful line, trimmed for the compact conn badge. */
function summarizeError(msg: string, maxLen = 64): string {
  const lines = msg
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // Prefer a line that looks like the actual failure, not empty SSH noise
  const preferred =
    lines.find((l) => /fail|error|denied|refused|timeout|not found|no such|permission/i.test(l)) ||
    lines[0] ||
    "error";
  let s = preferred.replace(/^Error:\s*/i, "");
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return s;
}

type ConnBadgeState = "ok" | "err" | "idle";
let lastConnError: string | null = null;

function setConnBadge(state: ConnBadgeState, label: string, detail?: string) {
  // Connection text badge removed from top bar — keep last error for log jump if needed
  if (state === "err" && detail) {
    lastConnError = detail;
  } else if (state === "ok") {
    lastConnError = null;
  }
  // Top-bar network icon: green ring when OK, red when not
  setNetworkBadge(
    state === "ok" ? "ok" : state === "err" ? "err" : "idle",
    detail || label,
  );
}

/** True when an error looks like Mac↔TV network / SSH is down. */
function isNetworkishError(msg: string): boolean {
  return /timed out|timeout|no route|host is down|could not resolve|connection refused|network is unreachable|Operation timed out|Broken pipe|No route to host|unreachable|Connection reset|ssh:|Network is down|Host is unreachable|connect failed|Control socket/i.test(
    msg,
  );
}

/**
 * Authoritative network icon: quick TCP probe to the TV host.
 * Call after boot (and when in doubt) so a local-only success cannot leave a false green.
 * Uses saved settings host (same as Fix network); keep form saved for accuracy.
 */
async function refreshNetworkBadgeFromProbe(opts?: { quiet?: boolean }): Promise<boolean> {
  const s = readForm();
  const label = `${s.user || "root"}@${s.host || "?"}`;
  try {
    // Fast TCP open (not a full SSH handshake) — fails quickly when network is down
    const ok = await invoke<boolean>("check_tv_reachable");
    if (ok) {
      setConnBadge("ok", label);
      return true;
    }
    const detail = `TV not reachable at ${s.host}:${s.port || 22}`;
    setConnBadge("err", `Unreachable ${s.host || "?"}`, detail);
    if (!opts?.quiet) {
      log(`${detail}. Click the red network icon to Fix network.`, true);
    }
    return false;
  } catch (e) {
    const msg = formatError(e);
    setConnBadge("err", summarizeError(msg), msg);
    if (!opts?.quiet) log(msg, true);
    return false;
  }
}

/**
 * Top-bar network icon (wifi): green = reachable, red = not → hover shows “Fix network”.
 * Settings panel button still gets a green text highlight when OK.
 */
function setNetworkBadge(
  state: "ok" | "err" | "busy" | "idle",
  detail?: string,
) {
  const el = document.getElementById("btn-fix-network") as HTMLButtonElement | null;
  if (el) {
    el.className = `net-badge${state === "idle" ? "" : ` ${state}`}`;
    if (state === "ok") {
      el.title = detail
        ? `Network OK — ${detail}`
        : "Network OK — TV is reachable. Click only if something stops working.";
      el.setAttribute("aria-label", "Network OK");
      el.dataset.tooltip = "Network OK";
      const tip = el.querySelector(".net-badge-tip");
      if (tip) tip.textContent = "Network OK";
    } else if (state === "busy") {
      el.title = "Fixing network…";
      el.setAttribute("aria-label", "Fixing network");
      el.dataset.tooltip = "Fixing network…";
      const tip = el.querySelector(".net-badge-tip");
      if (tip) tip.textContent = "Fixing network…";
    } else {
      // Not accessible — hover popup says Fix network
      el.title = "Fix network";
      el.setAttribute(
        "aria-label",
        detail
          ? `Network unreachable — Fix network. ${detail}`
          : "Network unreachable — Fix network",
      );
      el.dataset.tooltip = "Fix network";
      const tip = el.querySelector(".net-badge-tip");
      if (tip) tip.textContent = "Fix network";
    }
  }

  const settingsBtn = document.getElementById(
    "btn-fix-network-settings",
  ) as HTMLButtonElement | null;
  if (settingsBtn) {
    settingsBtn.classList.toggle("network-ok", state === "ok");
    settingsBtn.title =
      state === "ok"
        ? "Network OK — TV is reachable. Click only if something stops working."
        : "Fix network — rediscover TV IP, clear stale ARP, optional Wi‑Fi reset";
  }
}

/**
 * Soft busy — optional global hint only.
 * NEVER use for long SSH / install / play / restart work (that feels like a beachball).
 * Prefer per-button labels + `run(..., { busy: false })` (the default).
 * Does NOT set cursor:wait/progress (macOS beachball).
 */
let busyCount = 0;
function setBusy(busy: boolean) {
  if (busy) busyCount += 1;
  else busyCount = Math.max(0, busyCount - 1);
  const on = busyCount > 0;
  document.body.classList.toggle("is-busy", on);
  // Do not disable toolbar buttons — disabling + progress cursor felt frozen.
  if (!on) {
    syncCatalogToolbar();
  }
}

/** Let the browser paint (e.g. “Installing…”) before a long native await. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(() => resolve(), 0);
    });
  });
}

/** True while a long download/install is in flight (keeps UI responsive). */
let catalogInstallBusy = false;

// ── First-run disclaimer ─────────────────────────────────────────────────
// Bump the key suffix when the legal text changes so users re-acknowledge.
const DISCLAIMER_KEY = "ra-disclaimer-accepted-v2";
/** Open Settings after the user accepts the first-run disclaimer (e.g. missing SSH key). */
let openSettingsAfterDisclaimer = false;

function hasAcceptedDisclaimer(): boolean {
  try {
    return localStorage.getItem(DISCLAIMER_KEY) === "1";
  } catch {
    return false;
  }
}

function showDisclaimer(show: boolean) {
  const el = document.getElementById("disclaimer-overlay");
  if (!el) return;
  if (show) {
    el.removeAttribute("hidden");
    el.setAttribute("aria-hidden", "false");
    // Focus accept so keyboard / VoiceOver users can act immediately
    requestAnimationFrame(() => {
      document.getElementById("btn-disclaimer-accept")?.focus();
    });
  } else {
    el.setAttribute("hidden", "");
    el.setAttribute("aria-hidden", "true");
  }
}

function acceptDisclaimer() {
  try {
    localStorage.setItem(DISCLAIMER_KEY, "1");
  } catch {
    /* private mode — still dismiss for this session */
  }
  showDisclaimer(false);
  log("Disclaimer accepted.");
  if (openSettingsAfterDisclaimer) {
    openSettingsAfterDisclaimer = false;
    showSettings(true);
  }
}

// ── External game source links (open in browser) ─────────────────────────

type GameSourceSite = {
  id: string;
  name: string;
  desc: string;
  url: string;
  group: "primary" | "community";
};

/** Reference / download sites — not in-app Archive.org catalog items. */
const GAME_SOURCE_SITES: GameSourceSite[] = [
  {
    id: "lemon-amiga",
    name: "Lemon Amiga",
    desc: "Comprehensive database with 1,600+ Amiga games. Search A–Z for titles.",
    url: "https://www.lemonamiga.com/",
    group: "primary",
  },
  {
    id: "archive-amiga",
    name: "Internet Archive — Amiga Games",
    desc: "Thousands of free Amiga software titles available for download.",
    url: "https://archive.org/details/softwarelibrary_amiga_games",
    group: "primary",
  },
  {
    id: "hall-of-light",
    name: "Hall of Light",
    desc: "Amiga game database with downloads and information (hol.abime.net).",
    url: "https://amiga.abime.net/",
    group: "primary",
  },
  {
    id: "myabandonware",
    name: "My Abandonware",
    desc: "Large abandonware archive with a dedicated Amiga catalog.",
    url: "https://www.myabandonware.com/browse/platform/amiga/",
    group: "community",
  },
  {
    id: "romulation",
    name: "Romulation",
    desc: "Retro console and computer ROM downloads.",
    url: "https://www.romulation.org/",
    group: "community",
  },
  {
    id: "vimm",
    name: "Vimm's Lair",
    desc: "Classic console ROM preservation site.",
    url: "https://vimm.net/",
    group: "community",
  },
  {
    id: "old-games",
    name: "Old-Games.com",
    desc: "10,000+ classic PC and retro games to download.",
    url: "https://www.old-games.com/",
    group: "community",
  },
];

async function openGameSource(url: string, name: string) {
  try {
    await openUrl(url);
    log(`Opened ${name} in browser.`);
  } catch (e) {
    log(`Could not open ${name}: ${e}`, true);
    // Fallback: try window.open if opener plugin fails
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
  }
}

function renderGameSources() {
  const primary = document.getElementById("game-sources-primary");
  const community = document.getElementById("game-sources-community");
  if (!primary || !community) return;

  const fill = (box: HTMLElement, group: "primary" | "community") => {
    box.innerHTML = "";
    for (const site of GAME_SOURCE_SITES.filter((s) => s.group === group)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "game-source-card";
      btn.setAttribute("role", "listitem");
      btn.title = `Open ${site.url}`;
      btn.innerHTML = `
        <span class="game-source-name"></span>
        <span class="game-source-desc"></span>
        <span class="game-source-open">Open in browser ↗</span>`;
      btn.querySelector(".game-source-name")!.textContent = site.name;
      btn.querySelector(".game-source-desc")!.textContent = site.desc;
      btn.addEventListener("click", () => {
        void openGameSource(site.url, site.name);
      });
      box.appendChild(btn);
    }
  };

  fill(primary, "primary");
  fill(community, "community");
}

// ── Archive.org catalog (setup-amiga.sh + user custom sites) ─────────────

type CatalogSite = {
  n: number;
  id: string;
  label: string;
  desc: string;
  category?: string;
  custom?: boolean;
};
type CatalogAdf = {
  idx: number;
  title: string;
  file: string;
  size: number;
  url: string;
  siteId?: string;
  siteLabel?: string;
  /** Clean display name (TOSEC flags / disk tags stripped) */
  displayTitle?: string;
  /** How many dump variants were collapsed into this row */
  variantCount?: number;
  /** Disks in the preferred dump set (installs all) */
  diskCount?: number;
  /** Files to install when this row is selected (preferred dump, all disks) */
  installSet?: CatalogAdf[];
};

/** Titles per page when browsing a site / search results (unique games after collapse). */
const CATALOG_PAGE = 100;
const DEFAULT_TV_VOLUME = 4;

/** Installed basenames on the TV for the active catalog system (lowercased). */
let installedNames = new Set<string>();
/** Normalized stems for fuzzy match (no ext, alnum only). */
let installedStems = new Set<string>();

function normalizeCatalogKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parseInstalledList(raw: string): string[] {
  const out: string[] = [];
  for (const line of (raw || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    out.push(t);
  }
  return out;
}

function setInstalledFromNames(names: string[]) {
  installedNames = new Set(names.map((n) => n.toLowerCase()));
  installedStems = new Set(
    names.map((n) => normalizeCatalogKey(n)).filter(Boolean),
  );
}

function isCatalogItemInstalled(it: CatalogAdf): boolean {
  const files = (it.installSet?.length ? it.installSet : [it]).map(
    (x) => x.file || "",
  );
  for (const f of files) {
    if (!f) continue;
    if (installedNames.has(f.toLowerCase())) return true;
    const stem = normalizeCatalogKey(f);
    if (stem && installedStems.has(stem)) return true;
  }
  // Match cleaned title against installed stems (e.g. Goof Troop ↔ Goof_Troop_USA.sfc)
  const titleKey = normalizeCatalogKey(
    it.displayTitle || cleanCatalogTitle(it.title) || it.title,
  );
  if (titleKey && titleKey.length >= 4) {
    for (const stem of installedStems) {
      if (stem === titleKey) return true;
      // installed contains title or title contains installed (avoid tiny false positives)
      if (stem.length >= 6 && (stem.includes(titleKey) || titleKey.includes(stem))) {
        return true;
      }
    }
  }
  return false;
}

async function refreshInstalledForCatalogSystem() {
  try {
    const def = catalogSystemDef(catalogSystem);
    const out = await invoke<string>("ra_list_installed", {
      settings: readForm(),
      system: catalogSystem === "gbc" ? "gbc" : catalogSystem,
    });
    const names = parseInstalledList(out || "");
    setInstalledFromNames(names);
    if (names.length) {
      log(
        `TV has ${names.length} installed ${def.chip} file(s) in disks/${def.disksSubdir}`,
      );
    }
  } catch {
    // Offline / SSH fail — leave previous set; don't block browsing
  }
}
let catalogSites: CatalogSite[] = [];
let catalogAllSites: CatalogSite[] = [];
let catalogSiteId: string | null = null;
let catalogOffset = 0;
let catalogTotal = 0;
let catalogSearch = "";
let catalogItems: CatalogAdf[] = [];
/** "site" = browsing one Archive.org item; "search" = cross-site search */
let catalogMode: "site" | "search" = "site";
let catalogCategory: "all" | "games" | "demos" | "utils" = "all";
/**
 * Install catalog systems — keep in sync with CORE_FAMILIES / Settings cores.
 * Amiga uses setup-amiga.sh site list; others use built-in Archive.org libraries.
 */
type CatalogSystemId =
  | "amiga"
  | "snes"
  | "nes"
  | "genesis"
  | "gba"
  | "gbc"
  | "n64"
  | "psx";

let catalogSystem: CatalogSystemId = "amiga";

const CATALOG_SYSTEM_IDS: CatalogSystemId[] = [
  "amiga",
  "nes",
  "snes",
  "genesis",
  "gba",
  "gbc",
  "n64",
  "psx",
];

type CatalogSystemDef = {
  id: CatalogSystemId;
  label: string;
  /** Short chip label */
  chip: string;
  /** Core family for Settings hint */
  coreHint: string;
  /** TV folder under disks/ */
  disksSubdir: string;
  /** null = load from setup-amiga.sh (Amiga only) */
  sites: CatalogSite[] | null;
  hintHtml: string;
  searchPlaceholder: string;
};

/** Built-in Archive.org libraries (item id must have downloadable files). */
const ROM_CATALOG: Record<Exclude<CatalogSystemId, "amiga">, CatalogSite[]> = {
  snes: [
    {
      n: 1,
      id: "chrono-trigger-usa_202306",
      label: "SNES USA library",
      desc: "Large USA Super Nintendo ROM set (ZIP)",
      category: "games",
    },
    {
      n: 2,
      id: "super-mario-all-stars-super-mario-world_202509",
      label: "SNES multi-pack (small)",
      desc: "Small multi-game SNES pack (quick try)",
      category: "games",
    },
  ],
  nes: [
    {
      n: 1,
      id: "nes-roms",
      label: "NES ROM collection",
      desc: "Nintendo Entertainment System ROM pack",
      category: "games",
    },
    {
      n: 2,
      id: "No-Intro-Collection_2016-01-03_Early-Access",
      label: "No-Intro (multi)",
      desc: "Large No-Intro dump set (filter for NES)",
      category: "games",
    },
  ],
  genesis: [
    {
      n: 1,
      id: "megadrive-roms",
      label: "Mega Drive / Genesis (curated)",
      desc: "~60 individual ZIP ROMs — good for a quick try",
      category: "games",
    },
    {
      n: 2,
      id: "sega-genesis-romset-ultra-usa",
      label: "Genesis USA set (large)",
      desc: "Large USA Super/Genesis ZIP set (many titles)",
      category: "games",
    },
    {
      n: 3,
      id: "nointro.md",
      label: "No-Intro Mega Drive (complete)",
      desc: "Full No-Intro Mega Drive / Genesis set (.7z files)",
      category: "games",
    },
  ],
  gba: [
    {
      n: 1,
      id: "gba-roms",
      label: "GBA ROM collection",
      desc: "Game Boy Advance ROM pack",
      category: "games",
    },
    {
      n: 2,
      id: "GameboyAdvanceRoms",
      label: "GBA ROMs (alt)",
      desc: "Alternate GBA collection",
      category: "games",
    },
  ],
  gbc: [
    {
      n: 1,
      id: "gameboy-color-roms",
      label: "Game Boy / Color",
      desc: "GB / GBC ROM pack",
      category: "games",
    },
    {
      n: 2,
      id: "GameboyRoms",
      label: "Game Boy ROMs (alt)",
      desc: "Alternate GB collection",
      category: "games",
    },
  ],
  n64: [
    {
      n: 1,
      id: "nintendo-64-rom-super-mario-64",
      label: "Super Mario 64 (single)",
      desc: "One ZIP — Super Mario 64 (quick try)",
      category: "games",
    },
    {
      n: 2,
      id: "n64-archive-netmanyagi",
      label: "N64 Archive (large)",
      desc: "Large Nintendo 64 ZIP set (hundreds of titles)",
      category: "games",
    },
    {
      n: 3,
      id: "n64patchedwrestlingroms",
      label: "N64 wrestling (patched)",
      desc: "Small N64 wrestling ROM pack",
      category: "games",
    },
  ],
  psx: [
    {
      n: 1,
      id: "cylums-playstation-rom-collection",
      label: "PS1 (PBP pack — large)",
      desc: "Cylum’s PlayStation set (~690 PBP files — good for PCSX ReARMed)",
      category: "games",
    },
    {
      n: 2,
      id: "RedumpSonyPlayStationAmerica20160617",
      label: "PS1 Redump USA (ZIP)",
      desc: "Older Redump America set as ZIPs (large downloads)",
      category: "games",
    },
    {
      n: 3,
      id: "ps1-roms",
      label: "PS1 CHD sample",
      desc: "Small CHD collection (~40 games) — quick try",
      category: "games",
    },
  ],
};

function catalogSystemDef(id: CatalogSystemId): CatalogSystemDef {
  const core = (hint: string, sub: string) => ({
    coreHint: hint,
    disksSubdir: sub,
  });
  switch (id) {
    case "amiga":
      return {
        id,
        label: "Amiga",
        chip: "Amiga",
        ...core("PUAE 2021", "amiga"),
        sites: null,
        hintHtml:
          "<strong>Commodore Amiga</strong> — search Archive.org for games, demos, or utilities " +
          "(A–Z libraries). TOSEC duplicates are collapsed; multi-disk sets install together — " +
          "only use titles you are legally entitled to. Core: <strong>PUAE 2021</strong>.",
        searchPlaceholder: "Search Amiga games, demos, utilities…",
      };
    case "snes":
      return {
        id,
        label: "Super Nintendo",
        chip: "SNES",
        ...core("snes9x2010", "snes"),
        sites: ROM_CATALOG.snes,
        hintHtml:
          "<strong>Super Nintendo (SNES)</strong> — browse Archive.org ROM libraries, install to " +
          "<code>disks/snes</code>. Core: <strong>snes9x2010</strong> (Settings → cores).",
        searchPlaceholder: "Search within selected SNES library…",
      };
    case "nes":
      return {
        id,
        label: "NES",
        chip: "NES",
        ...core("FCEUmm", "nes"),
        sites: ROM_CATALOG.nes,
        hintHtml:
          "<strong>NES / Famicom</strong> — install to <code>disks/nes</code>. " +
          "Core: <strong>FCEUmm</strong> or Nestopia.",
        searchPlaceholder: "Search within selected NES library…",
      };
    case "genesis":
      return {
        id,
        label: "Mega Drive / Genesis",
        chip: "Genesis",
        ...core("Genesis Plus GX", "genesis"),
        sites: ROM_CATALOG.genesis,
        hintHtml:
          "<strong>Mega Drive / Genesis</strong> — install to <code>disks/genesis</code>. " +
          "Core: <strong>Genesis Plus GX</strong> or PicoDrive.",
        searchPlaceholder: "Search within selected Genesis library…",
      };
    case "gba":
      return {
        id,
        label: "Game Boy Advance",
        chip: "GBA",
        ...core("gpSP", "gba"),
        sites: ROM_CATALOG.gba,
        hintHtml:
          "<strong>Game Boy Advance</strong> — install to <code>disks/gba</code>. " +
          "Core: <strong>gpSP</strong> or mGBA.",
        searchPlaceholder: "Search within selected GBA library…",
      };
    case "gbc":
      return {
        id,
        label: "Game Boy / Color",
        chip: "GB/C",
        ...core("gambatte", "gb"),
        sites: ROM_CATALOG.gbc,
        hintHtml:
          "<strong>Game Boy / Color</strong> — install to <code>disks/gb</code>. " +
          "Core: <strong>gambatte</strong>.",
        searchPlaceholder: "Search within selected GB library…",
      };
    case "n64":
      return {
        id,
        label: "Nintendo 64",
        chip: "N64",
        ...core("ParaLLEl N64", "n64"),
        sites: ROM_CATALOG.n64,
        hintHtml:
          "<strong>Nintendo 64</strong> — install to <code>disks/n64</code>. " +
          "Core: <strong>ParaLLEl N64</strong> (recommended on webOS). " +
          "Avoid the newest webosbrew Mupen64Plus-Next unless your RetroArch ships GLIBCXX ≥ 3.4.32.",
        searchPlaceholder: "Search within selected N64 library…",
      };
    case "psx":
      return {
        id,
        label: "PlayStation 1",
        chip: "PS1",
        ...core("PCSX ReARMed", "psx"),
        sites: ROM_CATALOG.psx,
        hintHtml:
          "<strong>PlayStation 1</strong> — install to <code>disks/psx</code> (large images). " +
          "Core: <strong>PCSX ReARMed</strong> or SwanStation. Prefer CHD when available.",
        searchPlaceholder: "Search within selected PS1 library…",
      };
  }
}

function renderCatalogSystemChips() {
  const bar = document.querySelector(".catalog-system-bar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const id of CATALOG_SYSTEM_IDS) {
    const def = catalogSystemDef(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "system-chip" + (id === catalogSystem ? " active" : "");
    b.dataset.system = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", id === catalogSystem ? "true" : "false");
    b.textContent = def.chip;
    b.title = `${def.label} · core ${def.coreHint}`;
    b.addEventListener("click", () => void setCatalogSystem(id));
    bar.appendChild(b);
  }
}

function humanSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

function parseCatalogSites(text: string): CatalogSite[] {
  const out: CatalogSite[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("|");
    if (parts.length < 3) continue;
    const n = Number(parts[0]);
    if (!n) continue;
    // N|id|label|desc|category  (category optional for older scripts)
    const hasCat = parts.length >= 5;
    out.push({
      n,
      id: parts[1],
      label: parts[2],
      desc: hasCat ? parts[3] : parts.slice(3).join("|"),
      category: hasCat ? parts[4] : "pd",
    });
  }
  return out;
}

function parseCatalogAdfs(text: string): {
  items: CatalogAdf[];
  total: number;
  siteLabel: string;
  rawCount: number;
} {
  let total = 0;
  let siteLabel = "";
  const items: CatalogAdf[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      // Site labels can contain spaces ("A500 games collection") — do not use \S+
      const mTotal = t.match(/\btotal=(\d+)/);
      if (mTotal) total = Number(mTotal[1]) || 0;
      const mLab = t.match(/\bsite_label=(.+)$/);
      if (mLab) {
        siteLabel = mLab[1].trim();
      } else {
        const mSite = t.match(/\bsite=(.+?)\s+total=\d+/);
        if (mSite) {
          const raw = mSite[1].trim();
          siteLabel = raw === "search" ? "Search results" : raw.replace(/_/g, " ");
        }
      }
      continue;
    }
    const parts = t.split("|");
    if (parts.length < 5) continue;
    const idx = Number(parts[0]);
    if (!idx) continue;
    // idx|title|file|size|url  OR  idx|title|file|size|url|siteId|siteLabel
    items.push({
      idx,
      title: parts[1],
      file: parts[2],
      size: Number(parts[3]) || 0,
      url: parts[4],
      siteId: parts[5],
      siteLabel: parts[6],
    });
  }
  const rawCount = items.length;
  // Collapse TOSEC dump variants so Lemmings isn't listed 20× on one page
  const collapsed = collapseCatalogVariants(items);
  return {
    items: collapsed,
    total: total > 0 ? Math.max(total, collapsed.length) : collapsed.length,
    siteLabel,
    rawCount,
  };
}

/** Strip TOSEC dump flags / disk tags for grouping & display. */
function catalogGameKey(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\(Disk\s*\d+\s*of\s*\d+\)/gi, "")
    .replace(/\(Disk\s*\d+\)/gi, "")
    .replace(/\((?:Intro|Game|Program|Data|Disk)\)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)/g, "")
    .trim()
    .toLowerCase();
}

function cleanCatalogTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\(Disk\s*\d+\s*of\s*\d+\)/gi, "")
    .replace(/\(Disk\s*\d+\)/gi, "")
    .replace(/\((?:Intro|Game|Program|Data|Disk)\)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+,/g, ",")
    .trim();
}

/** Prefer verified/clean dumps; deprioritize bad dumps & pure alternates. */
function catalogDumpScore(title: string): number {
  let s = 100;
  if (/\[!\]/.test(title)) s += 50;
  if (/\[b[\s\]]/i.test(title) || /checksum error/i.test(title) || /\[b\d*\]/i.test(title))
    s -= 90;
  // TOSEC [a] / [a1] = alternate dump (not the same as (AGA))
  if (/\[a\d*\]/i.test(title)) s -= 20;
  if (/\[o\d*\]/i.test(title)) s -= 25; // overdump
  if (/\[f\d*\]/i.test(title)) s -= 5;
  if (/\[cr\b/i.test(title)) s += 8;
  if (/\[tr\b/i.test(title) || /\[t\s*\+/i.test(title)) s += 2;
  if (/\(Disk\s*1\s*of/i.test(title)) s += 15;
  else if (/\(Disk\s*[2-9]\s*of/i.test(title)) s -= 5;
  // Prefer unadorned names slightly
  if (!/\[[^\]]+\]/.test(title)) s += 12;
  return s;
}

/**
 * Collapse TOSEC variants of the same game into one row.
 * Install set = all disks of the highest-scoring dump family.
 */
function collapseCatalogVariants(items: CatalogAdf[]): CatalogAdf[] {
  if (items.length <= 1) {
    return items.map((it, i) => ({
      ...it,
      idx: i + 1,
      displayTitle: cleanCatalogTitle(it.title) || it.title,
      variantCount: 1,
      diskCount: 1,
      installSet: [it],
    }));
  }

  type Group = { key: string; variants: CatalogAdf[] };
  const groups = new Map<string, Group>();
  for (const it of items) {
    const key = catalogGameKey(it.title) || it.file.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { key, variants: [] };
      groups.set(key, g);
    }
    g.variants.push(it);
  }

  const out: CatalogAdf[] = [];
  // Preserve approximate alpha order by first-seen / title
  const ordered = Array.from(groups.values()).sort((a, b) => {
    const ta = cleanCatalogTitle(a.variants[0].title) || a.variants[0].title;
    const tb = cleanCatalogTitle(b.variants[0].title) || b.variants[0].title;
    return ta.localeCompare(tb, undefined, { sensitivity: "base" });
  });

  for (const g of ordered) {
    // Best dump per disk number → complete multi-disk set
    const byDisk = new Map<number, CatalogAdf[]>();
    for (const v of g.variants) {
      const d = Number((v.title.match(/Disk\s*(\d+)/i) || [])[1] || 0);
      const list = byDisk.get(d) || [];
      list.push(v);
      byDisk.set(d, list);
    }
    const preferred: CatalogAdf[] = [];
    const diskNums = Array.from(byDisk.keys()).sort((a, b) => {
      if (a === 0) return 1;
      if (b === 0) return -1;
      return a - b;
    });
    for (const d of diskNums) {
      const list = byDisk.get(d)!;
      list.sort((a, b) => catalogDumpScore(b.title) - catalogDumpScore(a.title));
      preferred.push(list[0]);
    }
    preferred.sort((a, b) => {
      const da = Number((a.title.match(/Disk\s*(\d+)/i) || [])[1] || 0);
      const db = Number((b.title.match(/Disk\s*(\d+)/i) || [])[1] || 0);
      if (da && db && da !== db) return da - db;
      return catalogDumpScore(b.title) - catalogDumpScore(a.title);
    });
    const primary =
      preferred.find((x) => /Disk\s*1\s*of/i.test(x.title)) || preferred[0];
    const display = cleanCatalogTitle(primary.title) || primary.title;
    out.push({
      ...primary,
      idx: out.length + 1,
      title: primary.title,
      displayTitle: display,
      variantCount: g.variants.length,
      diskCount: preferred.length,
      installSet: preferred,
      size: preferred.reduce((n, x) => n + (x.size || 0), 0),
    });
  }
  return out;
}

function syncCatalogToolbar() {
  const btnPrev = document.getElementById("btn-catalog-prev") as HTMLButtonElement | null;
  const btnNext = document.getElementById("btn-catalog-next") as HTMLButtonElement | null;
  const btnPrevF = document.getElementById(
    "btn-catalog-prev-foot",
  ) as HTMLButtonElement | null;
  const btnNextF = document.getElementById(
    "btn-catalog-next-foot",
  ) as HTMLButtonElement | null;
  const btnInst = document.getElementById("btn-catalog-install") as HTMLButtonElement | null;
  const pager = document.getElementById("catalog-pager");
  const pagerLabel = document.getElementById("catalog-pager-label");
  if (!btnPrev || !btnNext || !btnInst) return;
  const hasResults = catalogItems.length > 0 || catalogTotal > 0;
  const canPage = catalogMode === "search" || !!catalogSiteId;
  const hasPrev = canPage && catalogOffset > 0;
  const hasNext = canPage && catalogOffset + CATALOG_PAGE < catalogTotal;
  const page = Math.floor(catalogOffset / CATALOG_PAGE) + 1;
  const pages = Math.max(1, Math.ceil(catalogTotal / CATALOG_PAGE) || 1);
  const from = catalogTotal === 0 ? 0 : catalogOffset + 1;
  const to = Math.min(catalogOffset + catalogItems.length, catalogTotal);

  btnPrev.disabled = !hasPrev;
  btnNext.disabled = !hasNext;
  if (btnPrevF) btnPrevF.disabled = !hasPrev;
  if (btnNextF) {
    btnNextF.disabled = !hasNext;
    btnNextF.textContent = hasNext
      ? `Next page → (${page + 1}/${pages})`
      : "Next page →";
  }
  if (btnPrevF) {
    btnPrevF.textContent = hasPrev
      ? `← Prev page (${page - 1}/${pages})`
      : "← Prev page";
  }
  if (pager) {
    pager.hidden = !(canPage && catalogTotal > CATALOG_PAGE);
  }
  if (pagerLabel) {
    pagerLabel.textContent =
      catalogTotal > 0
        ? `Games ${from}–${to} of ${catalogTotal} · page ${page}/${pages}`
        : "";
  }
  const selected = document.querySelectorAll<HTMLInputElement>(
    "#catalog-adfs input[type=checkbox]:checked",
  ).length;
  btnInst.disabled = catalogInstallBusy || !hasResults || selected === 0;
  if (catalogInstallBusy) {
    btnInst.textContent = "Installing…";
  } else {
    btnInst.textContent =
      selected > 1 ? `Install selected (${selected})` : "Install selected";
  }
}

function catalogPagePrev() {
  catalogOffset = Math.max(0, catalogOffset - CATALOG_PAGE);
  if (catalogMode === "search") void runCatalogSearch();
  else void loadCatalogAdfs();
}

function catalogPageNext() {
  if (catalogOffset + CATALOG_PAGE >= catalogTotal) return;
  catalogOffset += CATALOG_PAGE;
  if (catalogMode === "search") void runCatalogSearch();
  else void loadCatalogAdfs();
}

function applyCategoryFilter() {
  const def = catalogSystemDef(catalogSystem);
  if (catalogSystem !== "amiga") {
    // ROM libraries are games-only
    catalogSites = catalogAllSites.map((s, i) => ({ ...s, n: i + 1 }));
  } else if (catalogCategory === "all") {
    catalogSites = catalogAllSites.map((s, i) => ({ ...s, n: i + 1 }));
  } else {
    catalogSites = catalogAllSites
      .filter((s) => {
        if (s.custom) return true;
        const c = (s.category || "pd").toLowerCase();
        if (catalogCategory === "games") return c === "games";
        if (catalogCategory === "demos") return c === "demos";
        if (catalogCategory === "utils") return c === "utils" || c === "pd";
        return true;
      })
      .map((s, i) => ({ ...s, n: i + 1 }));
  }
  const hint = document.getElementById("catalog-cat-hint");
  if (hint) {
    if (catalogSystem !== "amiga") {
      hint.textContent = `(${def.chip})`;
    } else {
      hint.textContent =
        catalogCategory === "all" ? "(Amiga)" : `(Amiga · ${catalogCategory})`;
    }
  }
  renderCatalogSites();
}

function updateCatalogSystemUi() {
  document.querySelectorAll<HTMLButtonElement>("[data-system]").forEach((chip) => {
    const on = chip.dataset.system === catalogSystem;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-selected", on ? "true" : "false");
  });
  const def = catalogSystemDef(catalogSystem);
  const hint = document.getElementById("catalog-system-hint");
  const search = document.getElementById("catalog-search") as HTMLInputElement | null;
  const catBar = document.getElementById("catalog-category-bar");
  const title = document.getElementById("sec-install");
  if (title) title.textContent = `Install ${def.label} games`;
  if (hint) hint.innerHTML = def.hintHtml;
  if (search) search.placeholder = def.searchPlaceholder;
  // Games / demos / utils only apply to Amiga free catalog
  if (catBar) catBar.hidden = catalogSystem !== "amiga";
}

async function setCatalogSystem(sys: CatalogSystemId) {
  if (catalogSystem === sys) return;
  catalogSystem = sys;
  catalogSiteId = null;
  catalogOffset = 0;
  catalogMode = "site";
  catalogItems = [];
  catalogTotal = 0;
  $input("catalog-search").value = "";
  catalogSearch = "";
  updateCatalogSystemUi();
  $("catalog-adfs").innerHTML = `<div class="empty">Select a site on the left, or search above.</div>`;
  $("catalog-meta").textContent = "";
  const pager = document.getElementById("catalog-pager");
  if (pager) pager.hidden = true;
  await loadCatalogSites();
  syncCatalogToolbar();
}

async function loadCatalogSites() {
  const box = $("catalog-sites");
  box.innerHTML = `<div class="empty">Loading sites…</div>`;
  updateCatalogSystemUi();

  const def = catalogSystemDef(catalogSystem);
  if (def.sites) {
    catalogAllSites = def.sites.map((s, i) => ({ ...s, n: i + 1 }));
    catalogSites = catalogAllSites.slice();
    applyCategoryFilter();
    // Auto-open the first library so SNES/N64/… are never a blank right pane
    if (catalogSites.length && !catalogSiteId) {
      void selectCatalogSite(catalogSites[0].id);
    }
    return;
  }

  // Amiga — load from setup-amiga.sh (local script; does NOT prove TV is reachable)
  try {
    const settings = readForm();
    const out = await invoke<string>("amiga_list_sites", {
      settings,
      category: null,
    });
    // Do not setConnBadge("ok") here — list-sites can succeed offline and left a false green.
    return await finishLoadCatalogSites(out);
  } catch (e) {
    const err = formatError(e);
    log(err, true);
    // Only paint network red for real connectivity failures (path/script errors stay local)
    if (isNetworkishError(err)) {
      setConnBadge("err", summarizeError(err), err);
    }
    const short = summarizeError(err, 120);
    box.innerHTML = `<div class="empty err-empty">Failed to load Amiga sites.<br/><span class="err-detail">${escapeHtml(short)}</span><br/><span class="muted">Fix Control script path in Settings (folder must also contain setup-amiga.sh).</span></div>`;
    return;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function finishLoadCatalogSites(out: string) {
  const box = $("catalog-sites");
  const builtin = parseCatalogSites(out);
  let custom: CatalogSite[] = [];
  try {
    const raw = await invoke<
      { id: string; label: string; desc: string; url: string }[]
    >("amiga_list_custom_sites");
    custom = raw.map((s) => ({
      n: 0,
      id: s.id,
      label: s.label || s.id,
      desc: s.desc || s.url || "Custom site",
      category: "pd",
      custom: true,
    }));
  } catch {
    /* ignore */
  }
  catalogAllSites = [
    ...custom,
    ...builtin.map((s) => ({ ...s, custom: false as const })),
  ];
  if (!catalogAllSites.length) {
    box.innerHTML = `<div class="empty">No sites returned.</div>`;
    return;
  }
  applyCategoryFilter();
}

function renderCatalogSites() {
  const box = $("catalog-sites");
  box.innerHTML = "";
  for (const site of catalogSites) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-item";
    btn.dataset.siteId = site.id;
    btn.setAttribute("role", "option");
    btn.innerHTML = `
      <div class="site-row">
        <div class="site-text">
          <span class="site-label"></span>
          <span class="site-desc"></span>
        </div>
      </div>`;
    const labelEl = btn.querySelector(".site-label")!;
    labelEl.textContent = `${site.n}. ${site.label}`;
    if (site.custom) {
      const badge = document.createElement("span");
      badge.className = "site-badge";
      badge.textContent = "custom";
      labelEl.appendChild(document.createTextNode(" "));
      labelEl.appendChild(badge);
    }
    btn.querySelector(".site-desc")!.textContent = site.desc;
    if (catalogSiteId === site.id) btn.classList.add("selected");

    if (site.custom) {
      const row = btn.querySelector(".site-row")!;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "site-remove";
      rm.textContent = "Remove";
      rm.title = "Remove custom site";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        void removeCustomCatalogSite(site.id);
      });
      row.appendChild(rm);
    }

    btn.addEventListener("click", () => {
      void selectCatalogSite(site.id);
    });
    box.appendChild(btn);
  }
}

async function addCustomCatalogSite() {
  const url = $input("catalog-site-url").value.trim();
  const label = $input("catalog-site-label").value.trim();
  if (!url) {
    log("Enter an Archive.org URL or item id.", true);
    return;
  }
  const btn = document.getElementById(
    "btn-catalog-add-site",
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevLabel = btn.textContent || "Add site";
    btn.textContent = "Adding…";
  }
  await yieldToUi();
  try {
    const site = await invoke<{ id: string; label: string }>("amiga_add_custom_site", {
      url,
      label: label || null,
    });
    log(`Added custom site: ${site.label} (${site.id})`);
    $input("catalog-site-url").value = "";
    $input("catalog-site-label").value = "";
    await loadCatalogSites();
    await selectCatalogSite(site.id);
  } catch (e) {
    log(String(e), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevLabel || "Add site";
      delete btn.dataset.prevLabel;
    }
  }
}

async function removeCustomCatalogSite(id: string) {
  if (!window.confirm(`Remove custom site “${id}”?`)) return;
  try {
    await invoke("amiga_remove_custom_site", { id });
    log(`Removed custom site ${id}`);
    if (catalogSiteId === id) {
      catalogSiteId = null;
      $("catalog-adfs").innerHTML = `<div class="empty">Select a site on the left.</div>`;
      $("catalog-meta").textContent = "";
    }
    await loadCatalogSites();
    syncCatalogToolbar();
  } catch (e) {
    log(String(e), true);
  }
}

async function selectCatalogSite(id: string, opts?: { keepSearch?: boolean }) {
  catalogSiteId = id;
  catalogMode = "site";
  catalogOffset = 0;
  // Leftover search (e.g. from Amiga) was zeroing single-file packs like SM64.
  // Clear unless the user is intentionally re-filtering within the same list.
  if (!opts?.keepSearch) {
    $input("catalog-search").value = "";
    catalogSearch = "";
  } else {
    catalogSearch = $input("catalog-search").value.trim();
  }
  document.querySelectorAll(".site-item").forEach((el) => {
    el.classList.toggle(
      "selected",
      (el as HTMLElement).dataset.siteId === id,
    );
  });
  await loadCatalogAdfs({ refresh: false });
}

function renderCatalogResults(
  parsed: {
    items: CatalogAdf[];
    total: number;
    siteLabel: string;
    rawCount?: number;
  },
  emptyHint: string,
) {
  const box = $("catalog-adfs");
  catalogItems = parsed.items;
  // Server total = unique titles in the full catalog (after TOSEC collapse)
  catalogTotal = parsed.total;
  const page = Math.floor(catalogOffset / CATALOG_PAGE) + 1;
  const pages = Math.max(1, Math.ceil(catalogTotal / CATALOG_PAGE) || 1);
  const cat =
    catalogCategory === "all" ? "" : ` · ${catalogCategory}`;
  const unique = catalogItems.length;
  const raw = parsed.rawCount ?? unique;
  const from = catalogTotal === 0 ? 0 : catalogOffset + 1;
  const to = Math.min(catalogOffset + unique, catalogTotal);
  const firstName = cleanCatalogTitle(catalogItems[0]?.title || "") || catalogItems[0]?.title;
  const lastName =
    cleanCatalogTitle(catalogItems[unique - 1]?.title || "") ||
    catalogItems[unique - 1]?.title;
  const rangeNames =
    firstName && lastName
      ? firstName === lastName
        ? firstName
        : `${firstName} → ${lastName}`
      : "";
  const moreHint =
    catalogOffset + CATALOG_PAGE < catalogTotal
      ? " · more on next page"
      : "";
  const collapsedNote =
    raw > unique ? `${unique} unique (${raw} files)` : `${unique} on this page`;
  $("catalog-meta").textContent = [
    parsed.siteLabel || "Results",
    cat.replace(/^ · /, ""),
    `${from}–${to} of ${catalogTotal}`,
    collapsedNote,
    rangeNames ? `(${rangeNames})` : "",
    `page ${page}/${pages}${moreHint}`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!catalogItems.length) {
    box.innerHTML = `<div class="empty">${emptyHint}</div>`;
    syncCatalogToolbar();
    return;
  }

  box.innerHTML = "";
  for (const it of catalogItems) {
    const row = document.createElement("div");
    row.className = "list-item catalog-adf-item";
    row.dataset.idx = String(it.idx);
    const already = isCatalogItemInstalled(it);
    if (already) row.classList.add("is-installed");
    const lab = document.createElement("label");
    lab.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(it.idx);
    cb.disabled = already;
    cb.addEventListener("change", () => {
      row.classList.toggle("is-selected", cb.checked);
      syncCatalogToolbar();
    });
    const name = document.createElement("span");
    name.className = "name";
    const display = it.displayTitle || it.title;
    const bits: string[] = [display];
    if (it.diskCount && it.diskCount > 1) bits.push(`${it.diskCount} disks`);
    if (it.variantCount && it.variantCount > 1)
      bits.push(`${it.variantCount} dumps → best`);
    if (it.siteLabel) bits.push(it.siteLabel);
    name.textContent = bits.join("  ·  ");
    name.title = it.title; // full TOSEC name on hover
    lab.appendChild(cb);
    lab.appendChild(name);
    // Clicking the row (not Install) toggles selection
    row.addEventListener("click", (e) => {
      if (already) return;
      const t = e.target as HTMLElement;
      if (t.closest("button") || t.closest("input") || t.closest(".installed-badge"))
        return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const size = document.createElement("span");
    size.className = "adf-size";
    size.textContent = humanSize(it.size);
    row.appendChild(lab);
    row.appendChild(size);
    if (already) {
      const badge = document.createElement("span");
      badge.className = "installed-badge";
      badge.textContent = "Installed";
      badge.title = "Already on the TV";
      row.appendChild(badge);
    } else {
      const inst = document.createElement("button");
      inst.type = "button";
      inst.className = "install";
      inst.disabled = false;
      const nInstall = it.installSet?.length || 1;
      inst.textContent = nInstall > 1 ? `Install ${nInstall}` : "Install";
      inst.title = `Download and install “${display}”${
        nInstall > 1 ? ` (${nInstall} disks)` : ""
      } to the TV`;
      inst.addEventListener("click", (e) => {
        e.stopPropagation();
        void installCatalogAdfs([it.idx]);
      });
      row.appendChild(inst);
    }
    box.appendChild(row);
  }
  syncCatalogToolbar();
}

async function loadCatalogAdfs(opts?: { refresh?: boolean }) {
  if (!catalogSiteId) {
    $("catalog-adfs").innerHTML = `<div class="empty">Search above, or select a site on the left.</div>`;
    $("catalog-meta").textContent = "";
    syncCatalogToolbar();
    return;
  }
  catalogMode = "site";
  const box = $("catalog-adfs");
  box.innerHTML = `<div class="empty">Loading disks from Archive.org…</div>`;
  $("catalog-meta").textContent = "Loading…";
  // Refresh installed list in parallel (for "Installed" badges)
  const installedP = refreshInstalledForCatalogSystem();
  const out = await run<string>(
    "amiga_list_adfs",
    {
      site: catalogSiteId,
      search: catalogSearch || null,
      limit: CATALOG_PAGE,
      offset: catalogOffset,
      refresh: opts?.refresh ?? false,
    },
    { busy: false },
  );
  await installedP;
  if (out == null) {
    box.innerHTML = `<div class="empty">Failed to load catalog.</div>`;
    $("catalog-meta").textContent = "";
    syncCatalogToolbar();
    return;
  }
  const empty = catalogSearch
    ? `No titles match “${catalogSearch}” in this library. Clear the search box (or click the library again) to list everything.`
    : "No playable ROMs found in this library (or catalog failed to load). Try Refresh.";
  renderCatalogResults(parseCatalogAdfs(out), empty);
}

/** Cross-site search for games / demos / utilities. */
async function runCatalogSearch(opts?: { refresh?: boolean }) {
  catalogSearch = $input("catalog-search").value.trim();
  if (!catalogSearch) {
    if (catalogSiteId) {
      catalogOffset = 0;
      await loadCatalogAdfs(opts);
      return;
    }
    const def = catalogSystemDef(catalogSystem);
    log(
      catalogSystem === "amiga"
        ? "Enter a search term for Amiga games, demos, or utilities."
        : `Enter a search term, or select a ${def.chip} library on the left.`,
      true,
    );
    return;
  }

  // Non-Amiga: filter within selected (or first) ROM library — not Amiga cross-search
  if (catalogSystem !== "amiga") {
    if (!catalogSiteId) {
      const first =
        catalogSites[0] || catalogSystemDef(catalogSystem).sites?.[0];
      if (first) {
        // keepSearch: user just typed a term and hit Search
        await selectCatalogSite(first.id, { keepSearch: true });
        return;
      }
    }
    catalogOffset = 0;
    catalogMode = "site";
    catalogSearch = catalogSearch; // already set above
    await loadCatalogAdfs(opts);
    return;
  }

  catalogMode = "search";
  catalogSiteId = null;
  document.querySelectorAll(".site-item").forEach((el) => {
    el.classList.remove("selected");
  });
  const box = $("catalog-adfs");
  box.innerHTML = `<div class="empty">Searching Amiga catalogs on Archive.org…</div>`;
  $("catalog-meta").textContent = "Searching…";
  const installedP = refreshInstalledForCatalogSystem();
  const out = await run<string>(
    "amiga_search_adfs",
    {
      search: catalogSearch,
      category: catalogCategory === "all" ? null : catalogCategory,
      limit: CATALOG_PAGE,
      offset: catalogOffset,
      refresh: opts?.refresh ?? false,
    },
    { busy: false },
  );
  await installedP;
  if (out == null) {
    box.innerHTML = `<div class="empty">Search failed.</div>`;
    $("catalog-meta").textContent = "";
    syncCatalogToolbar();
    return;
  }
  renderCatalogResults(
    parseCatalogAdfs(out),
    `No Amiga matches for “${catalogSearch}” in ${catalogCategory === "all" ? "all categories" : catalogCategory}.`,
  );
}

function selectedCatalogIds(): number[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "#catalog-adfs input[type=checkbox]:checked",
    ),
  )
    .map((el) => Number(el.value))
    .filter((n) => n > 0);
}

/** Row idx values currently installing (only those show "…"). */
let catalogInstallingIdxs = new Set<number>();

function restoreCatalogInstallButtons() {
  catalogInstallingIdxs = new Set();
  document
    .querySelectorAll<HTMLButtonElement>("button.install, #btn-catalog-install")
    .forEach((b) => {
      b.disabled =
        catalogInstallBusy ||
        (b.id === "btn-catalog-install" && selectedCatalogIds().length === 0);
      if (b.dataset.prevLabel) {
        b.textContent = b.dataset.prevLabel;
        delete b.dataset.prevLabel;
      } else if (
        b.classList.contains("install") &&
        (b.textContent === "…" ||
          b.textContent === "..." ||
          /installing/i.test(b.textContent || ""))
      ) {
        const row = b.closest<HTMLElement>(".list-item[data-idx]");
        const idx = Number(row?.dataset.idx || 0);
        const item = catalogItems.find((i) => i.idx === idx);
        const nInstall = item?.installSet?.length || 1;
        b.textContent = nInstall > 1 ? `Install ${nInstall}` : "Install";
      } else if (
        b.id === "btn-catalog-install" &&
        (/install/i.test(b.textContent || "") || b.textContent === "…")
      ) {
        /* leave bulk label to syncCatalogToolbar */
      }
    });
  syncCatalogToolbar();
}

/**
 * Update install progress banner/meta.
 * Only the row(s) being installed switch to "…" — other ROMs keep their Install label.
 */
function setCatalogInstallProgress(
  msg: string | null,
  activeIdxs?: number[],
) {
  const meta = document.getElementById("catalog-meta");
  if (meta && msg != null) meta.textContent = msg;
  const banner = document.getElementById("catalog-install-banner");
  if (banner) {
    if (msg) {
      banner.hidden = false;
      banner.textContent = msg;
      banner.classList.add("busy");
    } else {
      banner.hidden = true;
      banner.textContent = "";
      banner.classList.remove("busy");
    }
  }

  if (activeIdxs) {
    catalogInstallingIdxs = new Set(activeIdxs);
  }

  const bulk = document.getElementById(
    "btn-catalog-install",
  ) as HTMLButtonElement | null;
  if (bulk) {
    bulk.disabled =
      catalogInstallBusy || selectedCatalogIds().length === 0;
    if (catalogInstallBusy) {
      if (!bulk.dataset.prevLabel) {
        bulk.dataset.prevLabel = (bulk.textContent || "Install selected").trim();
      }
      bulk.textContent = "Installing…";
    }
  }

  // Per-row: only active installs show "…"; others keep "Install" (disabled while busy)
  document
    .querySelectorAll<HTMLButtonElement>("#catalog-adfs button.install")
    .forEach((b) => {
      const row = b.closest<HTMLElement>(".list-item[data-idx]");
      const idx = Number(row?.dataset.idx || 0);
      const item = catalogItems.find((i) => i.idx === idx);
      const already = item ? isCatalogItemInstalled(item) : false;
      const isActive =
        catalogInstallBusy && idx > 0 && catalogInstallingIdxs.has(idx);
      // Block concurrent installs, but only the active row(s) change label
      b.disabled = catalogInstallBusy || already;
      if (isActive) {
        if (!b.dataset.prevLabel) {
          const cur = (b.textContent || "Install").trim();
          b.dataset.prevLabel =
            cur === "…" || cur === "..." ? "Install" : cur;
        }
        b.textContent = "…";
      } else if (b.dataset.prevLabel) {
        b.textContent = b.dataset.prevLabel;
        delete b.dataset.prevLabel;
      } else if (b.textContent === "…" || b.textContent === "...") {
        // Never leave a non-active row stuck on ellipsis
        const nInstall = item?.installSet?.length || 1;
        b.textContent = nInstall > 1 ? `Install ${nInstall}` : "Install";
      }
    });

  if (!catalogInstallBusy) {
    restoreCatalogInstallButtons();
  }
}

async function installCatalogAdfs(ids: number[]) {
  if (!ids.length) return;
  if (catalogInstallBusy) {
    log("An install is already running — wait for it to finish.", true);
    return;
  }
  const picks = ids
    .map((idx) => catalogItems.find((i) => i.idx === idx))
    .filter((x): x is CatalogAdf => !!x);
  if (!picks.length) {
    log("No matching catalog rows for the selection.", true);
    return;
  }

  // Expand preferred multi-disk sets; de-dupe by URL
  const expanded: CatalogAdf[] = [];
  const seenUrl = new Set<string>();
  for (const p of picks) {
    const set = p.installSet?.length ? p.installSet : [p];
    for (const it of set) {
      const u = it.url?.trim();
      if (!u || seenUrl.has(u)) continue;
      seenUrl.add(u);
      expanded.push(it);
    }
  }
  if (!expanded.length) {
    log("Selected items have no download URL — reload the catalog and try again.", true);
    return;
  }

  const gameLabels = picks.map((p) => p.displayTitle || p.title);
  const ok = window.confirm(
    `Install ${picks.length} game${picks.length === 1 ? "" : "s"} ` +
      `(${expanded.length} disk image${expanded.length === 1 ? "" : "s"}) to the TV?\n\n` +
      gameLabels
        .slice(0, 8)
        .map((t, i) => {
          const p = picks[i];
          const disks = p.installSet?.length || 1;
          return `• ${t}${disks > 1 ? ` (${disks} disks)` : ""}`;
        })
        .join("\n") +
      (gameLabels.length > 8 ? `\n… and ${gameLabels.length - 8} more` : "") +
      `\n\nBest dump is chosen automatically when many TOSEC variants exist.\n` +
      `Downloaded from Archive.org and uploaded over SSH.\nOnly install titles you are entitled to use.\n\n` +
      `The app stays usable while this runs — watch the activity log for progress.`,
  );
  if (!ok) return;

  catalogInstallBusy = true;
  const def = catalogSystemDef(catalogSystem);
  const progressLabel =
    picks.length === 1
      ? `Installing “${gameLabels[0]}” → disks/${def.disksSubdir}…`
      : `Installing ${picks.length} ${def.chip} titles → disks/${def.disksSubdir}…`;
  // Only the selected row(s) show "…" — never rewrite every Install button
  setCatalogInstallProgress(
    progressLabel,
    picks.map((p) => p.idx),
  );
  log(
    `Installing ${picks.length} ${def.label} title(s) / ${expanded.length} file(s) → disks/${def.disksSubdir}…`,
  );
  for (const it of expanded) {
    log(`  → ${it.title}  (${it.file || it.url})`);
  }
  log("Watch the activity log — install can take a few minutes for large ROMs.");

  // Paint progress before the long native job starts
  await yieldToUi();

  try {
    // busy: false — do NOT freeze the whole app
    const r = await run<string>(
      "amiga_install_urls",
      {
        items: expanded.map((it) => ({
          url: it.url,
          file: it.file || "",
          title: it.title || "",
        })),
        contentSystem: catalogSystem,
      },
      { busy: false },
    );
    if (r != null) {
      log(r.trimEnd());
      // Mark newly installed files so the catalog shows "Installed"
      for (const it of expanded) {
        if (it.file) {
          installedNames.add(it.file.toLowerCase());
          const stem = normalizeCatalogKey(it.file);
          if (stem) installedStems.add(stem);
        }
        const tk = normalizeCatalogKey(
          it.displayTitle || cleanCatalogTitle(it.title) || it.title,
        );
        if (tk) installedStems.add(tk);
      }
      await refreshInstalledForCatalogSystem();
      log(
        `Install finished → disks/${def.disksSubdir}/ — refreshing Games, demos & media on TV…`,
      );
      await reloadAdfs({ busy: false });
      if (catalogSystem !== "amiga") {
        log(
          `${def.label}: use Play next to the title in Games, demos & media (needs engine ${def.coreHint} installed).`,
        );
      }
      // Re-render current page so badges flip to Installed
      if (catalogItems.length) {
        renderCatalogResults(
          {
            items: catalogItems,
            total: catalogTotal,
            siteLabel:
              document.getElementById("catalog-meta")?.textContent?.split(" · ")[0] ||
              "",
            rawCount: catalogItems.length,
          },
          "No titles.",
        );
      }
      const meta = document.getElementById("catalog-meta");
      if (meta) {
        meta.textContent =
          catalogSystem === "amiga"
            ? "Install finished ✓ — Amiga disks refreshed"
            : `Install finished ✓ → disks/${def.disksSubdir} (use ${def.coreHint} core)`;
      }
    } else {
      log("Install failed — see error above.", true);
      const meta = document.getElementById("catalog-meta");
      if (meta) meta.textContent = "Install failed — see activity log";
    }
  } finally {
    catalogInstallBusy = false;
    restoreCatalogInstallButtons();
    const banner = document.getElementById("catalog-install-banner");
    if (banner) {
      banner.hidden = true;
      banner.textContent = "";
      banner.classList.remove("busy");
    }
    syncCatalogToolbar();
  }
}

async function setDefaultTvVolume() {
  try {
    const raw = await invoke<string>("ra_volume_set", {
      settings: readForm(),
      level: DEFAULT_TV_VOLUME,
    });
    log(`TV volume set to ${DEFAULT_TV_VOLUME}. ${raw.trim()}`);
  } catch (e) {
    log(`Could not set default volume: ${e}`, true);
  }
}

function readForm(): Settings {
  return {
    host: $input("host").value.trim(),
    user: $input("user").value.trim(),
    sshKey: $input("sshKey").value.trim(),
    port: Number($input("port").value) || 22,
    scriptPath: $input("scriptPath").value.trim(),
    sshExtra: $input("sshExtra").value.trim(),
    raDir: $input("raDir").value.trim(),
    disksDir: $input("disksDir").value.trim(),
    systemDir: $input("systemDir").value.trim(),
    corePath: $input("corePath").value.trim(),
  };
}

// ── TV screensaver while app is open ─────────────────────────────────────
const SS_OPT_KEY = "ra-disable-screensaver";
let screensaverDisabledThisSession = false;

function isDisableScreensaverOpt(): boolean {
  try {
    const v = localStorage.getItem(SS_OPT_KEY);
    // Default ON — only an explicit "0" turns it off
    if (v === null || v === "") return true;
    return v === "1";
  } catch {
    return true;
  }
}

function setDisableScreensaverOpt(on: boolean) {
  try {
    localStorage.setItem(SS_OPT_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  const el = document.getElementById(
    "opt-disable-screensaver",
  ) as HTMLInputElement | null;
  if (el) el.checked = on;
}

function setScreensaverUiStatus(msg: string, ok?: boolean) {
  const el = document.getElementById("screensaver-status");
  if (!el) return;
  el.textContent = msg;
  el.className =
    "field-status" +
    (ok === true ? " ok" : ok === false ? " err" : "");
}

/** Disable TV screensaver (saves previous state on TV for restore on quit). */
async function applyScreensaverDisable(opts?: { quiet?: boolean }) {
  if (!isDisableScreensaverOpt()) return false;
  try {
    const settings = readForm();
    const out = await invoke<string>("ra_screensaver_disable", { settings });
    await invoke("mark_screensaver_disabled_session", { active: true });
    screensaverDisabledThisSession = true;
    if (!opts?.quiet) {
      log(
        "TV screensaver disabled while this app is open (restored on quit).\n" +
          (out?.trim() ? out.trimEnd() : ""),
      );
    }
    setScreensaverUiStatus("✓ Screensaver off on TV until you quit this app", true);
    return true;
  } catch (e) {
    const err = formatError(e);
    if (!opts?.quiet) log(`Could not disable TV screensaver: ${err}`, true);
    setScreensaverUiStatus(`Could not disable: ${summarizeError(err, 80)}`, false);
    return false;
  }
}

/** Restore TV screensaver (previous on/off). Safe to call if never disabled. */
async function applyScreensaverRestore(opts?: { quiet?: boolean }) {
  if (!screensaverDisabledThisSession && !isDisableScreensaverOpt()) {
    // Still try if flag exists from a previous crash
  }
  try {
    const settings = readForm();
    const out = await invoke<string>("ra_screensaver_restore", { settings });
    await invoke("mark_screensaver_disabled_session", { active: false });
    screensaverDisabledThisSession = false;
    if (!opts?.quiet && out?.trim()) log(out.trimEnd());
    if (!opts?.quiet) log("TV screensaver restored.");
    setScreensaverUiStatus("Screensaver restored on TV", true);
    return true;
  } catch (e) {
    const err = formatError(e);
    if (!opts?.quiet) log(`Screensaver restore: ${err}`, true);
    // Clear local flag so we don't loop forever; TV may still restore via flag file
    try {
      await invoke("mark_screensaver_disabled_session", { active: false });
    } catch {
      /* ignore */
    }
    screensaverDisabledThisSession = false;
    setScreensaverUiStatus(`Restore: ${summarizeError(err, 80)}`, false);
    return false;
  }
}

function wireScreensaverSetting() {
  const el = document.getElementById(
    "opt-disable-screensaver",
  ) as HTMLInputElement | null;
  if (!el) return;
  el.checked = isDisableScreensaverOpt();
  el.addEventListener("change", () => {
    const on = el.checked;
    setDisableScreensaverOpt(on);
    if (on) {
      void applyScreensaverDisable({ quiet: false });
    } else {
      // User turned off the option → restore screensaver now
      void applyScreensaverRestore({ quiet: false });
    }
  });
  // Best-effort restore if the window is closed cleanly from the webview
  window.addEventListener("pagehide", () => {
    if (screensaverDisabledThisSession || isDisableScreensaverOpt()) {
      // fire-and-forget; Rust Exit handler is the reliable path
      void applyScreensaverRestore({ quiet: true });
    }
  });
}

function writeForm(s: Settings) {
  $input("host").value = s.host ?? "";
  $input("user").value = s.user ?? "";
  $input("sshKey").value = s.sshKey ?? "";
  $input("port").value = String(s.port || 22);
  $input("scriptPath").value = s.scriptPath ?? "";
  $input("sshExtra").value = s.sshExtra ?? "";
  $input("raDir").value = s.raDir ?? DEFAULT_RA;
  $input("disksDir").value = s.disksDir ?? `${DEFAULT_RA}/disks/amiga`;
  $input("systemDir").value = s.systemDir ?? `${DEFAULT_RA}/system`;
  $input("corePath").value =
    s.corePath ?? `${DEFAULT_RA}/cores/puae2021_libretro.so`;
  void refreshPathStatus();
  void refreshCoreSelect({ busy: false });
}

function applyAmigaPathDefaults() {
  $input("raDir").value = DEFAULT_RA;
  $input("disksDir").value = `${DEFAULT_RA}/disks/amiga`;
  $input("systemDir").value = `${DEFAULT_RA}/system`;
  $input("corePath").value = `${DEFAULT_RA}/cores/puae2021_libretro.so`;
  syncCoreSelectFromPath();
  log("Amiga TV paths set to defaults (not saved yet).");
}

/** Amiga cores used by Play ADF — keep separate from SNES/GBA/etc. */
const KNOWN_AMIGA_CORES: { file: string; label: string }[] = [
  { file: "puae2021_libretro.so", label: "Commodore Amiga (PUAE 2021)" },
  { file: "puae_libretro.so", label: "Commodore Amiga (PUAE)" },
  { file: "amiberry_libretro.so", label: "Commodore Amiga (Amiberry)" },
];

/**
 * Optional other-system engines (SNES, NES, …). Used by Play on non-Amiga media.
 * Prefer light ARM-friendly cores for webOS TVs.
 */
const KNOWN_OTHER_CORES: { file: string; label: string }[] = [
  // Nintendo
  { file: "snes9x2010_libretro.so", label: "Super Nintendo (snes9x2010)" },
  { file: "fceumm_libretro.so", label: "NES / Famicom (FCEUmm)" },
  { file: "nestopia_libretro.so", label: "NES / Famicom (Nestopia)" },
  // Prefer ParaLLEl first in install UI (works on stock RA 1.22.2 libstdc++).
  // Current webosbrew Mupen needs GLIBCXX_3.4.32; use May-2025 mupen or parallel.
  { file: "parallel_n64_libretro.so", label: "Nintendo 64 (ParaLLEl N64) — recommended on webOS" },
  { file: "mupen64plus_next_libretro.so", label: "Nintendo 64 (Mupen64Plus-Next)" },
  { file: "gpsp_libretro.so", label: "Game Boy Advance (gpSP)" },
  { file: "gambatte_libretro.so", label: "Game Boy / Color (gambatte)" },
  // Sega
  { file: "genesis_plus_gx_libretro.so", label: "Mega Drive / Genesis (Genesis Plus GX)" },
  { file: "picodrive_libretro.so", label: "Mega Drive / Genesis / 32X (PicoDrive)" },
  // Sony
  { file: "pcsx_rearmed_libretro.so", label: "PlayStation 1 (PCSX ReARMed)" },
  { file: "swanstation_libretro.so", label: "PlayStation 1 (SwanStation)" },
];

/**
 * Stylized console marks (original geometric icons — not official trademarks).
 * Used for “engines” cards and scope chips.
 */
const ENGINE_LOGOS: Record<string, string> = {
  amiga: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#c41e3a"/><text x="24" y="32" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="22" fill="#fff">A</text></svg>`,
  nes: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#6b7280"/><rect x="8" y="14" width="32" height="20" rx="3" fill="#e5e7eb"/><circle cx="16" cy="24" r="3" fill="#1f2937"/><circle cx="32" cy="22" r="2.2" fill="#b91c1c"/><circle cx="36" cy="26" r="2.2" fill="#b91c1c"/><rect x="20" y="22" width="6" height="4" rx="1" fill="#9ca3af"/></svg>`,
  snes: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#5b4b8a"/><rect x="7" y="16" width="34" height="16" rx="8" fill="#c4b5fd"/><circle cx="16" cy="24" r="4" fill="#7c3aed"/><circle cx="30" cy="21" r="2.5" fill="#ef4444"/><circle cx="35" cy="24" r="2.5" fill="#eab308"/><circle cx="30" cy="27" r="2.5" fill="#22c55e"/><circle cx="25" cy="24" r="2.5" fill="#3b82f6"/></svg>`,
  genesis: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#111827"/><path d="M10 30 L24 10 L38 30 Z" fill="#000" stroke="#22c55e" stroke-width="2"/><text x="24" y="28" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="9" fill="#22c55e">MD</text></svg>`,
  gba: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#1e3a5f"/><rect x="8" y="15" width="32" height="18" rx="4" fill="#93c5fd"/><rect x="14" y="18" width="14" height="10" rx="1.5" fill="#1e293b"/><circle cx="33" cy="22" r="2.5" fill="#f87171"/><circle cx="36" cy="26" r="2.5" fill="#fbbf24"/></svg>`,
  gbc: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#4b5563"/><rect x="14" y="8" width="20" height="32" rx="3" fill="#9ca3af"/><rect x="17" y="12" width="14" height="12" rx="1" fill="#111827"/><circle cx="20" cy="30" r="2" fill="#ef4444"/><circle cx="28" cy="30" r="2" fill="#3b82f6"/></svg>`,
  n64: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#14532d"/><path d="M14 34 V14 L24 28 L34 14 V34" fill="none" stroke="#86efac" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="24" r="3" fill="#fbbf24"/></svg>`,
  psx: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#0f172a"/><circle cx="18" cy="18" r="5" fill="none" stroke="#22d3ee" stroke-width="2.2"/><rect x="26" y="14" width="9" height="9" fill="none" stroke="#a78bfa" stroke-width="2.2"/><path d="M14 34 L19 26 L24 34" fill="none" stroke="#f472b6" stroke-width="2.2" stroke-linejoin="round"/><path d="M28 26 L34 26 M31 26 V34" fill="none" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  other: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#374151"/><rect x="12" y="12" width="24" height="24" rx="4" fill="#6b7280"/><circle cx="24" cy="24" r="6" fill="#9ca3af"/></svg>`,
};

/**
 * When several downloadable cores cover the same system, mark one as recommended.
 * `prefer` is tried in order; first match in the visible list wins.
 * UI calls these “engines” (libretro cores under the hood).
 */
const CORE_FAMILIES: {
  id: string;
  title: string;
  short: string;
  engineLabel: string;
  accent: string;
  amiga: boolean;
  /** Tokens used for server-side catalog filter */
  filterHints: string[];
  prefer: string[];
  match: (file: string, label: string) => boolean;
}[] = [
  {
    id: "amiga",
    title: "Commodore Amiga",
    short: "Amiga",
    engineLabel: "Amiga engine",
    accent: "#c41e3a",
    amiga: true,
    filterHints: ["amiga", "puae", "amiberry"],
    prefer: ["puae2021_libretro.so", "puae_libretro.so", "amiberry_libretro.so"],
    match: (f, l) => /puae|amiberry|uae4arm|amiga/i.test(`${f} ${l}`),
  },
  {
    id: "snes",
    title: "Super Nintendo",
    short: "SNES",
    engineLabel: "SNES engine",
    accent: "#7c3aed",
    amiga: false,
    filterHints: ["snes", "snes9x", "bsnes"],
    prefer: ["snes9x2010_libretro.so", "snes9x_libretro.so", "bsnes_libretro.so"],
    match: (f, l) => /snes9x|bsnes|snes/i.test(`${f} ${l}`),
  },
  {
    id: "nes",
    title: "NES / Famicom",
    short: "NES",
    engineLabel: "NES engine",
    accent: "#6b7280",
    amiga: false,
    filterHints: ["nes", "fceumm", "nestopia", "famicom"],
    prefer: ["fceumm_libretro.so", "nestopia_libretro.so", "quicknes_libretro.so"],
    match: (f, l) =>
      /fceumm|nestopia|quicknes|famicom|(^|[^a-z])nes([^a-z]|$)/i.test(`${f} ${l}`) &&
      !/snes/i.test(`${f} ${l}`),
  },
  {
    id: "genesis",
    title: "Mega Drive / Genesis",
    short: "Genesis",
    engineLabel: "Genesis engine",
    accent: "#16a34a",
    amiga: false,
    filterHints: ["genesis", "megadrive", "mega drive", "picodrive"],
    prefer: [
      "genesis_plus_gx_libretro.so",
      "genesis_plus_gx_wide_libretro.so",
      "picodrive_libretro.so",
    ],
    match: (f, l) =>
      /genesis|picodrive|megadrive|mega.?drive|sega.?md|genplus/i.test(`${f} ${l}`),
  },
  {
    id: "psx",
    title: "PlayStation 1",
    short: "PS1",
    engineLabel: "PS1 engine",
    accent: "#0ea5e9",
    amiga: false,
    filterHints: ["psx", "playstation", "pcsx"],
    prefer: ["pcsx_rearmed_libretro.so", "swanstation_libretro.so", "mednafen_psx_libretro.so"],
    match: (f, l) => /pcsx|swanstation|beetle.?psx|mednafen.?psx|psx|playstation/i.test(`${f} ${l}`),
  },
  {
    id: "n64",
    title: "Nintendo 64",
    short: "N64",
    engineLabel: "N64 engine",
    accent: "#15803d",
    amiga: false,
    filterHints: ["n64", "mupen", "nintendo 64"],
    // Prefer ParaLLEl N64 on webOS: Mupen64Plus-Next from current webosbrew
    // cores needs GLIBCXX_3.4.32; RA 1.22.2 ships libstdc++ max 3.4.30 → crash.
    prefer: ["parallel_n64_libretro.so", "mupen64plus_next_libretro.so"],
    match: (f, l) => /mupen|parallel_n64|(^|[^a-z])n64([^a-z]|$)|nintendo.?64/i.test(`${f} ${l}`),
  },
  {
    id: "gba",
    title: "Game Boy Advance",
    short: "GBA",
    engineLabel: "GBA engine",
    accent: "#2563eb",
    amiga: false,
    filterHints: ["gba", "gpsp", "mgba"],
    prefer: ["gpsp_libretro.so", "mgba_libretro.so", "vba_next_libretro.so"],
    match: (f, l) => /gpsp|mgba|vba|gba|game.?boy.?advance/i.test(`${f} ${l}`),
  },
  {
    id: "gbc",
    title: "Game Boy / Color",
    short: "GB/C",
    engineLabel: "GB engine",
    accent: "#64748b",
    amiga: false,
    filterHints: ["gambatte", "sameboy", "gbc"],
    prefer: ["gambatte_libretro.so", "sameboy_libretro.so", "tgbdual_libretro.so"],
    match: (f, l) =>
      /gambatte|sameboy|tgbdual|gb_libretro|gbc/i.test(`${f} ${l}`) &&
      !/gba|advance/i.test(`${f} ${l}`),
  },
];

function engineFamilyFor(file: string, label: string) {
  for (const fam of CORE_FAMILIES) {
    if (fam.match(file, label)) return fam;
  }
  return null;
}

function engineLogoHtml(systemId: string): string {
  return ENGINE_LOGOS[systemId] || ENGINE_LOGOS.other;
}

/** Short engine name from libretro filename, e.g. puae2021_libretro.so → PUAE 2021 */
function engineDisplayName(file: string, label: string): string {
  // Prefer parenthetical core name from label: "Super Nintendo (snes9x2010)"
  const m = label.match(/\(([^)]+)\)\s*$/);
  if (m?.[1] && m[1].length < 40) return m[1];
  return file
    .replace(/_libretro\.so$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Downloadable-core catalog filter chips (Settings). */
type CoreScope =
  | "amiga"
  | "nes"
  | "snes"
  | "genesis"
  | "psx"
  | "n64"
  | "other"
  | "all";
let coreCatalogScope: CoreScope = "amiga";

const CORE_SCOPE_IDS: CoreScope[] = [
  "amiga",
  "nes",
  "snes",
  "genesis",
  "psx",
  "n64",
  "other",
  "all",
];

function isCoreScope(v: string | null | undefined): v is CoreScope {
  return !!v && (CORE_SCOPE_IDS as string[]).includes(v);
}

function isAmigaCore(file: string, label = ""): boolean {
  const blob = `${file} ${label}`;
  return /puae|amiberry|uae4arm|(^|[^a-z])amiga/i.test(blob);
}

function coreFamilyTitle(file: string, label: string): string {
  const fam = engineFamilyFor(file, label);
  if (fam) return fam.title;
  return isAmigaCore(file, label) ? "Commodore Amiga" : "Other system";
}

function coreScopeLabel(scope: CoreScope): string {
  switch (scope) {
    case "amiga":
      return "Amiga engines";
    case "nes":
      return "NES engines";
    case "snes":
      return "SNES engines";
    case "genesis":
      return "Genesis engines";
    case "psx":
      return "PS1 engines";
    case "n64":
      return "N64 engines";
    case "other":
      return "other engines";
    case "all":
      return "all engines";
  }
}

/** Build a console-logo scope chip bar (Settings catalog + engines panel). */
function renderEngineScopeChips(host: HTMLElement | null) {
  if (!host) return;
  const scopes: { id: CoreScope; label: string; logo: string }[] = [
    { id: "amiga", label: "Amiga", logo: "amiga" },
    { id: "nes", label: "NES", logo: "nes" },
    { id: "snes", label: "SNES", logo: "snes" },
    { id: "genesis", label: "Genesis", logo: "genesis" },
    { id: "psx", label: "PS1", logo: "psx" },
    { id: "n64", label: "N64", logo: "n64" },
    { id: "other", label: "Other", logo: "other" },
    { id: "all", label: "All", logo: "other" },
  ];
  host.innerHTML = "";
  host.classList.add("engine-scope-bar");
  host.setAttribute("role", "tablist");
  host.setAttribute("aria-label", "Engine system filter");
  for (const s of scopes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `engine-scope-chip core-scope-chip${
      coreCatalogScope === s.id ? " active" : ""
    }`;
    btn.dataset.coreScope = s.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", coreCatalogScope === s.id ? "true" : "false");
    btn.innerHTML = `<span class="engine-scope-logo">${engineLogoHtml(s.logo)}</span><span class="engine-scope-label">${escapeHtml(s.label)}</span>`;
    btn.addEventListener("click", () => {
      if (!isCoreScope(s.id)) return;
      coreCatalogScope = s.id;
      host.querySelectorAll(".engine-scope-chip, .core-scope-chip").forEach((c) => {
        const on = (c as HTMLElement).dataset.coreScope === s.id;
        c.classList.toggle("active", on);
        c.setAttribute("aria-selected", on ? "true" : "false");
      });
      // Keep any legacy chips in sync if present
      document.querySelectorAll("[data-core-scope]").forEach((c) => {
        if (c === btn || host.contains(c)) return;
        const on = (c as HTMLElement).dataset.coreScope === s.id;
        c.classList.toggle("active", on);
        c.setAttribute("aria-selected", on ? "true" : "false");
      });
      void listAllAvailableCores();
    });
    host.appendChild(btn);
  }
}

/** Server-side filter string for a catalog scope (empty = full index). */
function coreScopeServerFilter(scope: CoreScope, textFilter: string): string {
  if (textFilter) return textFilter;
  if (scope === "all" || scope === "other") return "";
  if (scope === "amiga") return "amiga";
  const fam = CORE_FAMILIES.find((f) => f.id === scope);
  return fam?.filterHints[0] || "";
}

function coreMatchesScope(
  scope: CoreScope,
  file: string,
  label: string,
  amiga: boolean,
): boolean {
  if (scope === "all") return true;
  if (scope === "amiga") return amiga;
  if (scope === "other") {
    // Everything not in a featured family (and not Amiga)
    if (amiga) return false;
    return !CORE_FAMILIES.some((f) => !f.amiga && f.match(file, label));
  }
  const fam = CORE_FAMILIES.find((f) => f.id === scope);
  return fam ? fam.match(file, label) : true;
}

/** Files to highlight as recommended when their system family has >1 core in the list. */
function recommendedCoreFiles(
  cores: { file: string; label: string }[],
): Map<string, string> {
  const out = new Map<string, string>(); // file → badge text
  if (cores.length < 2) return out;

  for (const fam of CORE_FAMILIES) {
    const members = cores.filter((c) => fam.match(c.file, c.label));
    if (members.length < 2) continue;
    const pick =
      fam.prefer.find((f) => members.some((m) => m.file === f)) || members[0].file;
    if (!out.has(pick)) {
      out.set(pick, "Recommended");
    }
  }
  return out;
}

const RETROBIOS_AMIGA =
  "https://raw.githubusercontent.com/Abdess/retrobios/main/bios/Commodore/Amiga";

/** Common Kickstarts users actually need — PUAE expects these filenames on the TV. */
type KickstartPreset = {
  id: string;
  /** Filename written to the TV system dir (PUAE convention) */
  file: string;
  label: string;
  version: string;
  model: string;
  desc: string;
  recommended?: boolean;
  url: string;
};

const KICKSTART_PRESETS: KickstartPreset[] = [
  {
    id: "ks13-a500",
    file: "kick34005.A500",
    label: "Kickstart 1.3",
    version: "1.3 (34.5)",
    model: "A500",
    desc: "Most classic games — start here",
    recommended: true,
    url: `${RETROBIOS_AMIGA}/kick34005.A500`,
  },
  {
    id: "ks204-a500",
    file: "kick37175.A500",
    label: "Kickstart 2.04",
    version: "2.04 (37.175)",
    model: "A500+",
    desc: "Later A500 / Workbench 2 games",
    recommended: true,
    url: `${RETROBIOS_AMIGA}/kick37175.A500`,
  },
  {
    id: "ks12-a500",
    file: "kick33180.A500",
    label: "Kickstart 1.2",
    version: "1.2 (33.180)",
    model: "A500",
    desc: "Very early titles that need 1.2",
    url: `${RETROBIOS_AMIGA}/kick33180.A500`,
  },
  {
    id: "ks31-a1200",
    file: "kick40068.A1200",
    label: "Kickstart 3.1",
    version: "3.1 (40.068)",
    model: "A1200",
    desc: "AGA games and Workbench 3.x",
    recommended: true,
    url: `${RETROBIOS_AMIGA}/kick40068.A1200`,
  },
  {
    id: "ks31-a4000",
    file: "kick40068.A4000",
    label: "Kickstart 3.1",
    version: "3.1 (40.068)",
    model: "A4000",
    desc: "A4000 / some AGA software",
    url: `${RETROBIOS_AMIGA}/kick40068.A4000`,
  },
  {
    id: "ks205-a600",
    file: "kick40063.A600",
    label: "Kickstart 3.1",
    version: "3.1 (40.063)",
    model: "A600",
    desc: "A600-oriented 3.1 image",
    url: `${RETROBIOS_AMIGA}/kick40063.A600`,
  },
  {
    id: "ks-cd32",
    file: "kick40060.CD32",
    label: "CD32 Kickstart",
    version: "3.1 (40.060)",
    model: "CD32",
    desc: "Amiga CD32 console games",
    url: `${RETROBIOS_AMIGA}/kick40060.CD32`,
  },
  {
    id: "ks-cd32-ext",
    file: "kick40060.CD32.ext",
    label: "CD32 extended ROM",
    version: "ext",
    model: "CD32",
    desc: "Pair with CD32 Kickstart",
    url: `${RETROBIOS_AMIGA}/kick40060.CD32.ext`,
  },
  {
    id: "ks-cdtv",
    file: "kick34005.CDTV",
    label: "CDTV Kickstart",
    version: "1.3",
    model: "CDTV",
    desc: "Commodore CDTV",
    url: `${RETROBIOS_AMIGA}/kick34005.CDTV`,
  },
];

type InstalledCore = { id: string; file: string; label: string; path: string };

function coresDirFromSettings(): string {
  const ra = $input("raDir").value.trim() || DEFAULT_RA;
  return `${ra.replace(/\/$/, "")}/cores`;
}

function corePathForFile(file: string): string {
  return `${coresDirFromSettings()}/${file}`;
}

function basenameCore(path: string): string {
  const p = path.trim().replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function syncCoreSelectFromPath() {
  const sel = document.getElementById("core-select") as HTMLSelectElement | null;
  if (!sel) return;
  const path = $input("corePath").value.trim();
  const file = basenameCore(path);
  if (!file) return;
  // Prefer exact path match, then file match
  for (const opt of Array.from(sel.options)) {
    if (opt.value === path || opt.dataset.file === file) {
      sel.value = opt.value;
      return;
    }
  }
  // Custom path not in list — add option
  const opt = document.createElement("option");
  opt.value = path;
  opt.dataset.file = file;
  opt.textContent = `${file} (custom path)`;
  sel.appendChild(opt);
  sel.value = path;
}

function parseInstalledCoresMachine(raw: string): InstalledCore[] {
  const out: InstalledCore[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("(") || t.startsWith("==>")) continue;
    // id|file|label|path — path may contain no pipes; label must not
    const parts = t.split("|");
    if (parts.length < 3) continue;
    const id = parts[0]?.trim() || "";
    const file = parts[1]?.trim() || "";
    // Allow 3-field lines (id|file|label) or 4+ (path = rest joined)
    const label =
      parts.length >= 4
        ? parts.slice(2, -1).join("|").trim()
        : (parts[2] || "").trim();
    const path = parts.length >= 4 ? parts[parts.length - 1].trim() : "";
    if (!file.endsWith(".so")) continue;
    out.push({ id, file, label: label || file, path });
  }
  return out;
}

function appendCoreOpt(
  parent: HTMLElement,
  value: string,
  file: string,
  text: string,
) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.dataset.file = file;
  opt.textContent = text;
  parent.appendChild(opt);
}

/** Populate the Settings Amiga core dropdown (ADF play only). */
async function refreshCoreSelect(opts?: { busy?: boolean }) {
  const sel = document.getElementById("core-select") as HTMLSelectElement | null;
  if (!sel) return;
  const currentPath = $input("corePath").value.trim();
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Loading…";
  sel.appendChild(placeholder);

  let installed: InstalledCore[] = [];
  try {
    const raw = await run<string>("ra_list_cores_machine", undefined, {
      busy: opts?.busy === true,
    });
    if (raw) installed = parseInstalledCoresMachine(raw);
  } catch {
    /* offline / SSH fail — still show known cores */
  }

  sel.innerHTML = "";
  const installedFiles = new Set(installed.map((c) => c.file));
  const installedAmiga = installed.filter((c) => isAmigaCore(c.file, c.label));
  const installedOther = installed.filter((c) => !isAmigaCore(c.file, c.label));

  if (installedAmiga.length) {
    const og = document.createElement("optgroup");
    og.label = "Amiga — installed (use for Play ADF)";
    for (const c of installedAmiga) {
      appendCoreOpt(og, c.path, c.file, `${c.label} — ${c.file}`);
    }
    sel.appendChild(og);
  }

  const ogKnownAmiga = document.createElement("optgroup");
  ogKnownAmiga.label = installedAmiga.length
    ? "Amiga — not installed yet"
    : "Amiga cores (install to use)";
  for (const k of KNOWN_AMIGA_CORES) {
    if (installedFiles.has(k.file)) continue;
    appendCoreOpt(
      ogKnownAmiga,
      corePathForFile(k.file),
      k.file,
      `${k.label} — ${k.file}`,
    );
  }
  if (ogKnownAmiga.childElementCount) sel.appendChild(ogKnownAmiga);

  // Other systems power Play for SNES/NES/… (active path stays Amiga for ADF)
  if (installedOther.length) {
    const og = document.createElement("optgroup");
    og.label = "Other systems — installed (Play SNES/NES/…)";
    for (const c of installedOther) {
      const sys = coreFamilyTitle(c.file, c.label);
      appendCoreOpt(og, c.path, c.file, `[${sys}] ${c.label} — ${c.file}`);
    }
    sel.appendChild(og);
  }

  const ogKnownOther = document.createElement("optgroup");
  ogKnownOther.label = "Other systems — optional installs";
  for (const k of KNOWN_OTHER_CORES) {
    if (installedFiles.has(k.file)) continue;
    const sys = coreFamilyTitle(k.file, k.label);
    appendCoreOpt(
      ogKnownOther,
      corePathForFile(k.file),
      k.file,
      `[${sys}] ${k.label} — ${k.file}`,
    );
  }
  if (ogKnownOther.childElementCount) sel.appendChild(ogKnownOther);

  if (!sel.options.length) {
    appendCoreOpt(
      sel,
      corePathForFile("puae2021_libretro.so"),
      "puae2021_libretro.so",
      "Commodore Amiga (PUAE 2021)",
    );
  }

  // Restore selection; prefer Amiga if current path is empty
  if (currentPath) {
    $input("corePath").value = currentPath;
    syncCoreSelectFromPath();
  } else if (sel.options[0]) {
    sel.selectedIndex = 0;
    $input("corePath").value = sel.value;
  }

  // Soft warning if active path is not an Amiga core
  const activeFile = basenameCore($input("corePath").value);
  if (activeFile && !isAmigaCore(activeFile)) {
    log(
      `Note: active core “${activeFile}” is not an Amiga core. Play ADF needs PUAE/Amiberry.`,
      true,
    );
  }
}

async function installCoreByName(file: string) {
  const name = file.trim();
  if (!name) {
    log("No core selected.", true);
    return;
  }
  log(`Installing core ${name} on TV…`);
  await yieldToUi();
  // No global busy — core install can take a while on the TV
  const r = await run<string>("ra_install_core", { name }, { busy: false });
  if (r == null) return;
  log(r.trimEnd());

  let fileName = name.endsWith(".so") ? name : name.replace(/\.zip$/, "");
  if (!fileName.endsWith(".so")) {
    if (fileName.endsWith("_libretro")) fileName = `${fileName}.so`;
    else if (!fileName.includes("_libretro")) fileName = `${fileName}_libretro.so`;
  }

  // Only Amiga cores become the active Play-ADF core path
  if (isAmigaCore(fileName)) {
    $input("corePath").value = corePathForFile(fileName);
    log(`Amiga core for Play ADF set to ${fileName} (Save settings to keep).`);
  } else {
    log(
      `Installed ${fileName} — Play will use it for matching games (SNES/NES/…).\n` +
        `  (Amiga Play still needs PUAE/Amiberry as the active Amiga engine.)`,
    );
  }
  await refreshCoreSelect({ busy: false });
  await reloadCores({ busy: false });
}

async function listAllAvailableCores() {
  const box = $("core-available-list");
  const textFilter = $input("core-filter").value.trim();
  // Backend pre-filter when possible (smaller download); refined client-side.
  const serverFilter = coreScopeServerFilter(coreCatalogScope, textFilter);
  box.innerHTML = `<div class="empty muted">Loading core catalog…</div>`;
  const raw = await run<string>(
    "ra_list_available_cores",
    serverFilter ? { filter: serverFilter } : {},
  );
  if (raw == null) {
    box.innerHTML = `<div class="empty">Failed to load catalog — check network / SSH</div>`;
    return;
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|") && !l.startsWith("==>"));

  type CoreItem = { file: string; label: string; amiga: boolean; system: string };
  let cores: CoreItem[] = [];
  for (const line of lines) {
    const pipe = line.indexOf("|");
    const file = line.slice(0, pipe).trim();
    const label = line.slice(pipe + 1).trim();
    if (!file.endsWith(".so")) continue;
    const amiga = isAmigaCore(file, label);
    cores.push({
      file,
      label,
      amiga,
      system: coreFamilyTitle(file, label),
    });
  }

  // Client-side scope + text filter
  cores = cores.filter((c) =>
    coreMatchesScope(coreCatalogScope, c.file, c.label, c.amiga),
  );
  if (textFilter) {
    const q = textFilter.toLowerCase();
    cores = cores.filter(
      (c) =>
        c.file.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.system.toLowerCase().includes(q),
    );
  }

  if (!cores.length) {
    const scopeLabel = coreScopeLabel(coreCatalogScope);
    box.innerHTML = `<div class="empty muted">No cores match ${escapeHtml(scopeLabel)}${
      textFilter ? ` / “${escapeHtml(textFilter)}”` : ""
    }.</div>`;
    return;
  }

  const recommended = recommendedCoreFiles(cores);
  // Amiga group first when showing all; recommended first within group; then name
  cores.sort((a, b) => {
    if (coreCatalogScope === "all" && a.amiga !== b.amiga) {
      return a.amiga ? -1 : 1;
    }
    const ar = recommended.has(a.file) ? 0 : 1;
    const br = recommended.has(b.file) ? 0 : 1;
    if (ar !== br) return ar - br;
    if (a.system !== b.system) return a.system.localeCompare(b.system);
    return a.label.localeCompare(b.label) || a.file.localeCompare(b.file);
  });

  box.innerHTML = "";
  box.classList.add("engine-grid");
  let lastSection = "";
  for (const { file, label, amiga, system } of cores) {
    const fam = engineFamilyFor(file, label);
    const sysId = fam?.id || (amiga ? "amiga" : "other");
    const sectionKey = system;
    if (sectionKey !== lastSection) {
      lastSection = sectionKey;
      const head = document.createElement("div");
      head.className = `engine-section-head core-section-head${
        amiga ? " core-section-amiga" : " core-section-other"
      }`;
      head.innerHTML = `<span class="engine-section-logo">${engineLogoHtml(sysId)}</span><span class="engine-section-title"></span>`;
      (head.querySelector(".engine-section-title") as HTMLElement).textContent =
        amiga ? `${system} · Play ADF` : `${system} engines`;
      box.appendChild(head);
    }

    const isRec = recommended.has(file);
    const card = document.createElement("article");
    card.className = [
      "engine-card",
      isRec ? "engine-card-recommended" : "",
      amiga ? "engine-card-amiga" : "engine-card-other",
    ]
      .filter(Boolean)
      .join(" ");
    card.setAttribute("role", "listitem");
    card.style.setProperty("--engine-accent", fam?.accent || "#64748b");
    if (isRec) card.setAttribute("aria-label", `${label} (recommended engine)`);

    const engineName = engineDisplayName(file, label);
    card.innerHTML = `
      <div class="engine-card-logo">${engineLogoHtml(sysId)}</div>
      <div class="engine-card-body">
        <div class="engine-card-kicker"></div>
        <h4 class="engine-card-title"></h4>
        <p class="engine-card-file"></p>
        <div class="engine-card-badges"></div>
      </div>
      <div class="engine-card-actions"></div>`;
    (card.querySelector(".engine-card-kicker") as HTMLElement).textContent =
      fam?.engineLabel || (amiga ? "Amiga engine" : "Engine");
    (card.querySelector(".engine-card-title") as HTMLElement).textContent = engineName;
    (card.querySelector(".engine-card-file") as HTMLElement).textContent = file;
    const badges = card.querySelector(".engine-card-badges")!;
    const sysBadge = document.createElement("span");
    sysBadge.className = `core-sys-badge core-sys-${amiga ? "amiga" : "other"}`;
    sysBadge.textContent = fam?.short || system;
    badges.appendChild(sysBadge);
    if (isRec) {
      const badge = document.createElement("span");
      badge.className = "core-rec-badge";
      badge.textContent = recommended.get(file) || "Recommended";
      badges.appendChild(badge);
    }
    if (amiga) {
      const play = document.createElement("span");
      play.className = "engine-play-badge";
      play.textContent = "Play ADF";
      badges.appendChild(play);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = isRec || amiga ? "primary small" : "secondary small";
    btn.textContent = "Install engine";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await installCoreByName(file);
        btn.textContent = "Installed";
      } catch {
        btn.textContent = "Retry";
        btn.disabled = false;
      }
    });
    card.querySelector(".engine-card-actions")!.appendChild(btn);
    box.appendChild(card);
  }
  const amigaN = cores.filter((c) => c.amiga).length;
  const otherN = cores.length - amigaN;
  log(
    `Listed ${cores.length} downloadable engine${cores.length === 1 ? "" : "s"}` +
      ` (Amiga: ${amigaN}, other: ${otherN}` +
      `${recommended.size ? `, ${recommended.size} recommended` : ""}).`,
  );
}

type KickstartFile = { name: string; size: number };

function parseKickstartList(raw: string): KickstartFile[] {
  const out: KickstartFile[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes("|")) continue;
    const pipe = t.indexOf("|");
    const name = t.slice(0, pipe).trim();
    const size = Number(t.slice(pipe + 1).trim()) || 0;
    if (name) out.push({ name, size });
  }
  return out;
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setKickstartStatus(
  state: "ok" | "err" | "busy" | "idle",
  message: string,
) {
  const el = document.getElementById("kickstart-status");
  if (!el) return;
  el.textContent = message;
  el.className = `kickstart-status field-status${
    state === "ok" ? " ok" : state === "err" ? " err" : state === "busy" ? " busy" : ""
  }`;
}

/** Kickstart filenames currently on the TV (lowercased for match). */
let kickstartsOnTv = new Set<string>();

function renderKickstartFiles(files: KickstartFile[]) {
  const list = document.getElementById("kickstart-on-tv");
  if (!list) return;
  list.innerHTML = "";
  kickstartsOnTv = new Set(files.map((f) => f.name.toLowerCase()));
  if (!files.length) {
    list.hidden = true;
    updateKickstartPickerInstalled();
    return;
  }
  list.hidden = false;
  for (const f of files) {
    const li = document.createElement("li");
    const size = formatBytes(f.size);
    const preset = KICKSTART_PRESETS.find(
      (p) => p.file.toLowerCase() === f.name.toLowerCase(),
    );
    li.innerHTML = `<span class="kick-name"></span>${
      size ? `<span class="kick-size muted"></span>` : ""
    }`;
    (li.querySelector(".kick-name") as HTMLElement).textContent = preset
      ? `${f.name} · ${preset.label} (${preset.model})`
      : f.name;
    const sz = li.querySelector(".kick-size");
    if (sz) sz.textContent = size;
    list.appendChild(li);
  }
  updateKickstartPickerInstalled();
}

function isKickstartOnTv(file: string): boolean {
  const want = file.toLowerCase();
  if (kickstartsOnTv.has(want)) return true;
  // Tolerate extra suffixes some installs use (e.g. .rom)
  for (const onTv of kickstartsOnTv) {
    if (onTv === want || onTv.startsWith(want + ".") || want.startsWith(onTv + ".")) {
      return true;
    }
  }
  return false;
}

/** Single status chip: "Installed" if on TV, else "Recommended" for presets, else hidden. */
function updateKickstartCardStatus(card: HTMLElement) {
  const file = card.dataset.file || "";
  const id = card.dataset.id || "";
  const on = isKickstartOnTv(file);
  const preset = KICKSTART_PRESETS.find((p) => p.id === id);
  card.classList.toggle("kick-card-installed", on);
  card.classList.toggle("kick-card-rec", !on && !!preset?.recommended);

  const badge = card.querySelector(".kick-status-badge") as HTMLElement | null;
  if (badge) {
    badge.classList.remove("kick-status-installed", "kick-status-recommended");
    if (on) {
      badge.textContent = "Installed";
      badge.classList.add("kick-status-installed");
      badge.hidden = false;
      badge.removeAttribute("hidden");
    } else if (preset?.recommended) {
      badge.textContent = "Recommended";
      badge.classList.add("kick-status-recommended");
      badge.hidden = false;
      badge.removeAttribute("hidden");
    } else {
      badge.textContent = "";
      badge.hidden = true;
      badge.setAttribute("hidden", "");
    }
  }

  const cb = card.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (cb && on) {
    // Already installed — clear selection so user focuses on missing ones
    cb.checked = false;
    delete cb.dataset.userTouched;
  }
}

function updateKickstartPickerInstalled() {
  document.querySelectorAll<HTMLElement>(".kick-card").forEach((card) => {
    updateKickstartCardStatus(card);
  });
  updateKickstartInstallButton();
}

function updateKickstartInstallButton() {
  const btn = document.getElementById(
    "btn-install-kickstart",
  ) as HTMLButtonElement | null;
  if (!btn || btn.dataset.busy === "1") return;
  const n = getSelectedKickstartPresets().length;
  const custom = $input("kickstart-url")?.value.trim();
  if (n > 0) {
    btn.textContent =
      n === 1 ? "Install selected to TV" : `Install ${n} selected to TV`;
  } else if (custom) {
    btn.textContent = "Install custom URL to TV";
  } else {
    btn.textContent = "Install selected to TV";
  }
}

function getSelectedKickstartPresets(): KickstartPreset[] {
  const ids = new Set(
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        "#kickstart-picker input[type=checkbox]:checked",
      ),
    ).map((cb) => cb.value),
  );
  return KICKSTART_PRESETS.filter((p) => ids.has(p.id));
}

function setKickstartSelection(ids: string[] | "recommended" | "none") {
  const want =
    ids === "none"
      ? new Set<string>()
      : ids === "recommended"
        ? new Set(
            KICKSTART_PRESETS.filter(
              (p) => p.recommended && !isKickstartOnTv(p.file),
            ).map((p) => p.id),
          )
        : new Set(ids);
  document
    .querySelectorAll<HTMLInputElement>("#kickstart-picker input[type=checkbox]")
    .forEach((cb) => {
      const card = cb.closest(".kick-card") as HTMLElement | null;
      const file = card?.dataset.file || "";
      // Never select ones already on the TV
      cb.checked = want.has(cb.value) && !isKickstartOnTv(file);
      delete cb.dataset.userTouched;
    });
  updateKickstartInstallButton();
}

function renderKickstartPicker() {
  const box = document.getElementById("kickstart-picker");
  if (!box) return;
  box.innerHTML = "";
  for (const p of KICKSTART_PRESETS) {
    const card = document.createElement("label");
    card.className = "kick-card";
    card.dataset.file = p.file;
    card.dataset.id = p.id;
    card.innerHTML = `
      <input type="checkbox" value="" />
      <span class="kick-card-body">
        <span class="kick-card-top">
          <span class="kick-card-title"></span>
          <span class="kick-model-badge"></span>
          <span class="kick-status-badge" hidden></span>
        </span>
        <span class="kick-card-desc"></span>
        <span class="kick-card-file mono"></span>
      </span>`;
    const cb = card.querySelector("input")!;
    cb.value = p.id;
    // Pre-select recommended only if not already installed (status may load right after)
    cb.checked = !!p.recommended && !isKickstartOnTv(p.file);
    cb.addEventListener("change", () => {
      cb.dataset.userTouched = "1";
      // Don't allow "selected" highlight to stick for already-installed ROMs
      if (isKickstartOnTv(p.file)) {
        cb.checked = false;
        delete cb.dataset.userTouched;
      }
      updateKickstartInstallButton();
    });
    (card.querySelector(".kick-card-title") as HTMLElement).textContent =
      `${p.label} · ${p.version}`;
    (card.querySelector(".kick-model-badge") as HTMLElement).textContent =
      p.model;
    (card.querySelector(".kick-card-desc") as HTMLElement).textContent = p.desc;
    (card.querySelector(".kick-card-file") as HTMLElement).textContent = p.file;
    box.appendChild(card);
  }
  updateKickstartPickerInstalled();
}

/** Refresh Kickstart status from TV (and after install). */
async function refreshKickstartStatus(opts?: {
  busy?: boolean;
  quiet?: boolean;
  highlightName?: string;
}): Promise<KickstartFile[]> {
  const useBusy = opts?.busy === true;
  try {
    if (useBusy) setBusy(true);
    const raw = await run<string>("amiga_list_kickstarts", undefined, {
      busy: false,
      quiet: opts?.quiet !== false,
    });
    if (raw == null) {
      setKickstartStatus(
        "err",
        "Could not check Kickstart on TV — see activity log",
      );
      renderKickstartFiles([]);
      return [];
    }
    const files = parseKickstartList(raw);
    renderKickstartFiles(files);
    if (!files.length) {
      setKickstartStatus(
        "idle",
        "No Kickstart BIOS found on the TV yet — install one below",
      );
    } else {
      const names = files.map((f) => f.name).join(", ");
      const highlight = opts?.highlightName
        ? files.some(
            (f) =>
              f.name.toLowerCase() === opts.highlightName!.toLowerCase() ||
              f.name.toLowerCase().includes(
                opts.highlightName!.toLowerCase().replace(/\.(rom|a500|a1200)$/i, ""),
              ),
          )
        : false;
      setKickstartStatus(
        "ok",
        highlight
          ? `✓ Kickstart installed on TV (${files.length} file${files.length === 1 ? "" : "s"}): ${names}`
          : `✓ Kickstart on TV (${files.length}): ${names}`,
      );
    }
    return files;
  } catch (e) {
    const err = formatError(e);
    if (!opts?.quiet) log(err, true);
    setKickstartStatus("err", summarizeError(err, 100));
    renderKickstartFiles([]);
    return [];
  } finally {
    if (useBusy) setBusy(false);
  }
}

function guessKickstartFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(base);
  } catch {
    const base = url.split("/").filter(Boolean).pop() || "";
    return base.split("?")[0] || "";
  }
}

/** Build setup-amiga URL args: `filename=https://…` so the TV gets the right name. */
function kickstartInstallArgs(): { urls: string[]; labels: string[] } {
  const selected = getSelectedKickstartPresets();
  const urls: string[] = [];
  const labels: string[] = [];
  for (const p of selected) {
    urls.push(`${p.file}=${p.url}`);
    labels.push(`${p.label} (${p.model}) → ${p.file}`);
  }
  const custom = $input("kickstart-url")?.value.trim() || "";
  if (custom) {
    const name = guessKickstartFilenameFromUrl(custom);
    urls.push(name && !name.includes("=") ? `${name}=${custom}` : custom);
    labels.push(name ? `Custom → ${name}` : `Custom → ${custom}`);
  }
  return { urls, labels };
}

async function installKickstartFromUrl() {
  const { urls, labels } = kickstartInstallArgs();
  if (!urls.length) {
    log("Select one or more Kickstart ROMs, or enter a custom URL.", true);
    setKickstartStatus(
      "err",
      "Select Kickstart ROMs above (or open Custom URL)",
    );
    return;
  }
  const btn = document.getElementById(
    "btn-install-kickstart",
  ) as HTMLButtonElement | null;
  log(`Installing Kickstart (${labels.length})…\n  ${labels.join("\n  ")}`);
  setKickstartStatus(
    "busy",
    `Installing ${labels.length} Kickstart file${labels.length === 1 ? "" : "s"} to TV…`,
  );
  if (btn) {
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.textContent = "Installing…";
  }
  try {
    // Keep Settings usable — only this button shows “Installing…”
    await yieldToUi();
    const r = await run<string>("amiga_install_kickstart", { urls }, { busy: false });
    if (r == null) {
      setKickstartStatus(
        "err",
        "Kickstart install failed — see activity log",
      );
      if (btn) {
        delete btn.dataset.busy;
        btn.disabled = false;
        updateKickstartInstallButton();
      }
      return;
    }
    log(r.trimEnd());
    const expected = getSelectedKickstartPresets()[0]?.file;
    const files = await refreshKickstartStatus({
      busy: false,
      quiet: true,
      highlightName: expected,
    });
    if (files.length) {
      log(
        `Kickstart install confirmed on TV (${files.map((f) => f.name).join(", ")}).`,
      );
      if (btn) {
        btn.textContent = "Installed ✓";
        window.setTimeout(() => {
          delete btn.dataset.busy;
          btn.disabled = false;
          updateKickstartInstallButton();
        }, 2500);
      }
    } else {
      setKickstartStatus(
        "err",
        "Install finished but no Kickstart files found on TV — check system path / log",
      );
      log(
        "Kickstart install returned OK but system dir has no kick* files — check WEBOS_SYSTEM_DIR / Settings.",
        true,
      );
      if (btn) {
        delete btn.dataset.busy;
        btn.disabled = false;
        updateKickstartInstallButton();
      }
    }
  } catch (e) {
    const err = formatError(e);
    log(err, true);
    setKickstartStatus("err", summarizeError(err, 100));
    if (btn) {
      delete btn.dataset.busy;
      btn.disabled = false;
      updateKickstartInstallButton();
    }
  }
}

async function refreshPathStatus() {
  const key = $input("sshKey").value.trim();
  const script = $input("scriptPath").value.trim();
  const keyOk = key ? await invoke<boolean>("path_exists", { path: key }) : false;
  const scriptOk = script
    ? await invoke<boolean>("path_exists", { path: script })
    : false;
  const keyEl = $("sshKey-status");
  const scriptEl = $("scriptPath-status");
  const resolvedEl = $("sshKey-resolved");

  // Full resolved path so the user always sees where the key points
  if (key) {
    try {
      const resolved = await invoke<string>("resolve_path", { path: key });
      resolvedEl.innerHTML = keyOk
        ? `<strong>Location:</strong> ${escapeHtml(resolved)}`
        : `<strong>Expected location:</strong> ${escapeHtml(resolved)} <em>(file missing)</em>`;
    } catch {
      resolvedEl.textContent = key;
    }
  } else {
    resolvedEl.innerHTML =
      "<strong>Set a path</strong> — default is <code>~/.ssh/webos_deploy</code>";
  }

  keyEl.textContent = key
    ? keyOk
      ? "✓ private key found at this path"
      : "✗ no file at this path — Browse… or Use default"
    : "Enter path to your private key, or click Browse…";
  keyEl.className = `field-status ${keyOk ? "ok" : key ? "err" : ""}`;
  scriptEl.textContent = script
    ? scriptOk
      ? "✓ script found"
      : "✗ script not found"
    : "";
  scriptEl.className = `field-status ${scriptOk ? "ok" : script ? "err" : ""}`;
}

type SettingsSectionId =
  | "appearance"
  | "connection"
  | "amiga"
  | "kickstart"
  | "controller";

const SETTINGS_SECTIONS: {
  id: SettingsSectionId;
  lead: string;
}[] = [
  {
    id: "appearance",
    lead: "Color theme for this app and the mouse / volume / keyboard windows.",
  },
  {
    id: "connection",
    lead: "SSH host, key, and control script — how this Mac reaches the TV.",
  },
  {
    id: "amiga",
    lead: "ADF disks, system path, and which Amiga core Play uses on the TV.",
  },
  {
    id: "kickstart",
    lead: "Install Amiga KickStart BIOS ROMs the emulator needs (like a console BIOS).",
  },
  {
    id: "controller",
    lead: "Map a spare gamepad button to a mouse click while you play Amiga.",
  },
];

let settingsSection: SettingsSectionId = "connection";

function isSettingsSectionId(v: string | null | undefined): v is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === v);
}

/** Map legacy element ids / aliases to a settings section. */
function resolveSettingsSection(
  target?: string | null,
): SettingsSectionId | null {
  if (!target) return null;
  if (isSettingsSectionId(target)) return target;
  if (
    target === "settings-pad-map" ||
    target === "settings-sec-controller" ||
    target === "pad-map"
  ) {
    return "controller";
  }
  if (target === "settings-sec-kickstart" || target === "kickstart-picker") {
    return "kickstart";
  }
  if (target === "settings-sec-amiga" || target === "core-select") return "amiga";
  if (target === "settings-sec-connection" || target === "host") return "connection";
  if (target === "settings-sec-appearance" || target === "theme") return "appearance";
  return null;
}

function showSettingsSection(id: SettingsSectionId) {
  settingsSection = id;
  const lead =
    SETTINGS_SECTIONS.find((s) => s.id === id)?.lead ||
    "Configure this Mac and the LG TV for RetroArch.";
  const leadEl = document.getElementById("settings-lead");
  if (leadEl) leadEl.textContent = lead;

  document
    .querySelectorAll<HTMLButtonElement>("[data-settings-section]")
    .forEach((b) => {
      const on = b.dataset.settingsSection === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });

  document
    .querySelectorAll<HTMLElement>("[data-settings-panel]")
    .forEach((panel) => {
      const on = panel.dataset.settingsPanel === id;
      panel.classList.toggle("active", on);
      if (on) {
        panel.removeAttribute("hidden");
        panel.hidden = false;
      } else {
        panel.setAttribute("hidden", "");
        panel.hidden = true;
      }
    });

  // Refresh section-specific live data when shown
  if (id === "amiga") {
    void refreshCoreSelect({ busy: false });
  }
  if (id === "kickstart") {
    setKickstartStatus("busy", "Checking TV for Kickstart…");
    void refreshKickstartStatus({ busy: false, quiet: true });
  }
  if (id === "controller") {
    renderPadMapDiagram();
    updatePadMapUi();
    void refreshPadMouseStatus();
  }

  const body = document.querySelector(".settings-body") as HTMLElement | null;
  if (body) body.scrollTop = 0;
}

function initSettingsNav() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-settings-section]")
    .forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.settingsSection;
        if (isSettingsSectionId(id)) showSettingsSection(id);
      });
    });
  const nav = document.querySelector(".settings-nav");
  nav?.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-settings-section]"),
    );
    if (!items.length) return;
    const cur = items.findIndex((b) => b.classList.contains("active"));
    let next = cur;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      next = (cur + 1) % items.length;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      next = (cur - 1 + items.length) % items.length;
    }
    e.preventDefault();
    const id = items[next]?.dataset.settingsSection;
    if (isSettingsSectionId(id)) {
      showSettingsSection(id);
      items[next]?.focus();
    }
  });
}

function showSettings(
  openPanel: boolean,
  opts?: { scrollTo?: string; section?: string },
) {
  const panel = $("settings-panel");
  const btn = $("btn-settings");
  if (openPanel) {
    panel.removeAttribute("hidden");
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    const section =
      resolveSettingsSection(opts?.section) ||
      resolveSettingsSection(opts?.scrollTo) ||
      settingsSection ||
      "connection";
    showSettingsSection(section);
    // Always warm SSH-related status when opening
    void refreshCoreSelect({ busy: false });
  } else {
    panel.setAttribute("hidden", "");
    btn.classList.remove("active");
    btn.setAttribute("aria-pressed", "false");
  }
}

async function initSettings() {
  try {
    const saved = await invoke<Settings>("load_settings");
    writeForm(saved);
    log("Loaded saved settings.");
  } catch {
    const def = await invoke<Settings>("default_settings");
    writeForm(def);
  }
}

async function saveSettings() {
  const s = readForm();
  const btn = document.getElementById("btn-save") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevLabel = btn.textContent || "Save settings";
    btn.textContent = "Saving…";
  }
  await yieldToUi();
  try {
    const msg = await invoke<string>("save_settings", { settings: s });
    log(msg);
    setConnBadge("ok", `${s.user}@${s.host}`);
    await refreshPathStatus();
    showSettings(false);
  } catch (e) {
    const err = formatError(e);
    log(err, true);
    setConnBadge("err", summarizeError(err), err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevLabel || "Save settings";
      delete btn.dataset.prevLabel;
    }
  }
}

async function testSsh() {
  const statusEl = $("ssh-test-status");
  const btn = $("btn-test-ssh") as HTMLButtonElement;
  statusEl.textContent = "Testing SSH…";
  statusEl.className = "field-status";
  btn.classList.remove("ssh-ok", "ssh-err");
  btn.disabled = true;
  const prev = btn.textContent || "Test SSH";
  btn.textContent = "Testing…";
  log("Testing SSH…");
  await yieldToUi();
  try {
    // Auto-save current form so Test uses latest fields
    await invoke("save_settings", { settings: readForm() });
    const msg = await invoke<string>("test_ssh_connection", {
      settings: readForm(),
    });
    const s = readForm();
    const summary = `SSH test passed → ${s.user}@${s.host}:${s.port || 22}`;
    statusEl.textContent = `✓ ${summary}`;
    statusEl.className = "field-status ok";
    btn.classList.add("ssh-ok");
    log(`${summary}\n${msg.trim()}`);
    setConnBadge("ok", `${s.user}@${s.host} · SSH ok`);
    // After a good SSH link, ensure gamepad autoconfig is in place (background)
    void setupController({ refresh: false, quiet: true, busy: false });
  } catch (e) {
    const err = formatError(e);
    const short = summarizeError(err, 80);
    statusEl.textContent = `✗ ${short}`;
    statusEl.title = err;
    statusEl.className = "field-status err";
    btn.classList.add("ssh-err");
    log(err, true);
    setConnBadge("err", `SSH: ${summarizeError(err, 48)}`, err);
    if (/timed out|no route|host is down|could not resolve|connection refused/i.test(err)) {
      log(
        "Tip: click Fix network (top bar or Settings → Connection) — same repair as Prime Remote (mDNS + clear stale ARP + optional Wi‑Fi reset).",
        true,
      );
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

type TvNetworkRepairReport = {
  reachable: boolean;
  ip: string;
  port: number;
  ipChanged: boolean;
  discovered: boolean;
  wifiRestarted: boolean;
  neighborFlushed: boolean;
  wolSent: boolean;
  steps: string[];
  advice: string | null;
};

function setFixNetworkButtonsBusy(busy: boolean) {
  const icon = document.getElementById(
    "btn-fix-network",
  ) as HTMLButtonElement | null;
  const settings = document.getElementById(
    "btn-fix-network-settings",
  ) as HTMLButtonElement | null;

  if (icon) {
    icon.disabled = busy;
    if (busy) {
      setNetworkBadge("busy");
    }
    // When un-busy, setConnBadge / repair result will set ok/err again
  }

  if (settings) {
    if (busy) {
      if (!settings.dataset.prevLabel) {
        settings.dataset.prevLabel = settings.textContent || "Fix network";
      }
      settings.disabled = true;
      settings.textContent = "Fixing…";
    } else {
      settings.disabled = false;
      settings.textContent = settings.dataset.prevLabel || "Fix network";
      delete settings.dataset.prevLabel;
    }
  }
}

/** Repair Mac↔TV path when host is unreachable — from macos-prime-remote-control. */
async function repairTvNetwork(opts?: { restartWifi?: boolean }) {
  // Soft first (mDNS + ARP + LAN scan). Hard = also bounce Mac Wi‑Fi.
  let restartWifi = opts?.restartWifi === true;
  const statusEl = document.getElementById("ssh-test-status");

  setFixNetworkButtonsBusy(true);
  if (statusEl) {
    statusEl.textContent = "Repairing… see activity log";
    statusEl.className = "field-status busy";
  }

  log("── Fix network ──────────────────────────────────");
  log(
    restartWifi
      ? "Hard repair: mDNS → SSH scan → clear ARP → restart Mac Wi‑Fi → re-test"
      : "Soft repair: mDNS → SSH scan → clear ARP → re-test (no Wi‑Fi bounce yet)",
  );
  log("Watch for a macOS password dialog (may appear behind this window).");

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<string>("network-repair-progress", (e) => {
      const parts = String(e.payload ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const l of parts) log(`  ${l}`);
    });
  } catch (e) {
    log(`(progress events unavailable: ${formatError(e)})`);
  }

  const runOnce = async (withWifi: boolean, useAdmin: boolean) => {
    // Persist form host/key so backend load_settings matches what user sees
    try {
      await invoke("save_settings", { settings: readForm() });
    } catch (e) {
      log(`(could not pre-save settings: ${formatError(e)})`);
    }
    // Match Prime Remote: backend loads settings; only pass repair flags
    return invoke<TvNetworkRepairReport>("repair_tv_network", {
      restartWifi: withWifi,
      sendWol: false,
      useAdmin,
      tvMac: null,
    });
  };

  try {
    // Soft: no Wi‑Fi bounce, no admin password (won't hang on hidden dialog)
    let report = await runOnce(restartWifi, false);

    // Soft failed → offer hard Wi‑Fi reset once
    if (!report.reachable && !restartWifi) {
      log("Soft repair did not restore SSH.");
      const doWifi = window.confirm(
        "Still unreachable.\n\n" +
          "Restart Mac Wi‑Fi now?\n" +
          "(Same approach as Prime Remote — Wi‑Fi drops for a few seconds.)",
      );
      if (doWifi) {
        restartWifi = true;
        log("Retrying with Mac Wi‑Fi restart…");
        report = await runOnce(true, false);
      }
    }

    // Still dead after Wi‑Fi → optional admin ARP flush (password dialog)
    if (!report.reachable) {
      const doAdmin = window.confirm(
        "Still unreachable.\n\n" +
          "Clear the Mac's stale ARP entry with admin rights?\n" +
          "A password dialog will appear — check behind this window if you don't see it.",
      );
      if (doAdmin) {
        log("Retrying with admin ARP flush…");
        report = await runOnce(false, true);
      }
    }

    const logText = $("log").textContent || "";
    for (const s of report.steps || []) {
      if (s && !logText.includes(s)) log(`  ${s}`);
    }

    if (report.ipChanged && report.ip) {
      $input("host").value = report.ip;
      log(`Host field set to ${report.ip}`);
      try {
        await invoke("save_settings", { settings: readForm() });
        log("Settings saved with new host.");
      } catch (e) {
        log(`Could not save settings: ${formatError(e)}`, true);
      }
    }

    if (report.reachable) {
      const label = `${readForm().user}@${report.ip || readForm().host}`;
      log(`✓ TV SSH reachable at ${report.ip}:${report.port}`);
      setConnBadge("ok", `${label} · network ok`);
      if (statusEl) {
        statusEl.textContent = `✓ Reachable at ${report.ip}:${report.port}`;
        statusEl.className = "field-status ok";
      }
      await testSsh();
    } else {
      log("Still cannot reach the TV over SSH.", true);
      if (report.advice) log(report.advice, true);
      log(
        "Manual check: TV on? Same Wi‑Fi? Developer Mode/SSH on? " +
          `Or run: scripts/fix-tv-ssh.sh --sudo --restart-wifi`,
        true,
      );
      setConnBadge(
        "err",
        `Unreachable ${report.ip || readForm().host}`,
        report.advice || "TV unreachable",
      );
      if (statusEl) {
        statusEl.textContent = `✗ Still unreachable${report.ip ? ` (${report.ip})` : ""}`;
        statusEl.className = "field-status err";
        statusEl.title = report.advice || "";
      }
    }
  } catch (e) {
    const err = formatError(e);
    log(`Fix network failed: ${err}`, true);
    if (/not allowed|unknown|Command repair/i.test(err)) {
      log("Quit the app completely and run it again so Fix network is loaded.", true);
    }
    setConnBadge("err", summarizeError(err), err);
    if (statusEl) {
      statusEl.textContent = `✗ ${summarizeError(err, 80)}`;
      statusEl.className = "field-status err";
    }
  } finally {
    try {
      unlisten?.();
    } catch {
      /* ignore */
    }
    setFixNetworkButtonsBusy(false);
  }
}

function wireFixNetworkButtons() {
  const run = () => {
    void repairTvNetwork({ restartWifi: false });
  };
  document.getElementById("btn-fix-network")?.addEventListener("click", run);
  document
    .getElementById("btn-fix-network-settings")
    ?.addEventListener("click", run);
}

/**
 * Invoke a Tauri command with connection settings.
 * Default: busy:false — never freeze the window for SSH work.
 */
async function run<T>(
  name: string,
  args?: Record<string, unknown>,
  opts?: { quiet?: boolean; busy?: boolean },
): Promise<T | null> {
  // Default false: app-wide busy was the #1 beachball source (cursor + disabled UI)
  const useBusy = opts?.busy === true;
  if (useBusy) setBusy(true);
  try {
    const settings = readForm();
    const result = await invoke<T>(name, { settings, ...args });
    setConnBadge("ok", `${settings.user}@${settings.host}`);
    return result;
  } catch (e) {
    const msg = formatError(e);
    if (!opts?.quiet) log(msg, true);
    setConnBadge("err", summarizeError(msg), msg);
    return null;
  } finally {
    if (useBusy) setBusy(false);
  }
}

/** Background status check (startup); no dedicated UI button. */
async function status() {
  const out = await run<string>("ra_status");
  if (out != null) log(out.trimEnd());
}

// ── Amiga gamepad → left mouse click ─────────────────────────────────────

type PadMouseBtn = {
  id: string;
  label: string;
  desc: string;
};

const PAD_MOUSE_BUTTONS: PadMouseBtn[] = [
  { id: "l3", label: "L3", desc: "Press left stick (recommended)" },
  { id: "r3", label: "R3", desc: "Press right stick" },
  { id: "select", label: "Select", desc: "Back / View" },
  { id: "start", label: "Start", desc: "Menu / Options" },
  { id: "l1", label: "L1", desc: "Left shoulder" },
  { id: "r1", label: "R1", desc: "Right shoulder" },
  { id: "l2", label: "L2", desc: "Left trigger (pull fully — analog)" },
  { id: "r2", label: "R2", desc: "Right trigger (pull fully — analog)" },
];

/** What the chosen pad button injects on the TV. */
type PadMapAction = "lmb" | "rmb" | "mmb";
const PAD_MAP_ACTIONS: { id: PadMapAction; label: string; short: string }[] = [
  { id: "lmb", label: "Left mouse button", short: "Left mouse" },
  { id: "rmb", label: "Right mouse button", short: "Right mouse" },
  { id: "mmb", label: "Middle mouse button", short: "Middle mouse" },
];

const PAD_MOUSE_KEY = "ra-amiga-pad-mouse-btn";
const PAD_MAP_ACTION_KEY = "ra-pad-map-action";
const PAD_MOUSE_ON_KEY = "ra-amiga-pad-mouse-enabled";
let padMouseBtn = "l3";
let padMapAction: PadMapAction = "lmb";

function isPadMapAction(v: string | null | undefined): v is PadMapAction {
  return v === "lmb" || v === "rmb" || v === "mmb";
}

function loadPadMousePref() {
  try {
    const v = localStorage.getItem(PAD_MOUSE_KEY);
    if (v && PAD_MOUSE_BUTTONS.some((b) => b.id === v)) padMouseBtn = v;
    const a = localStorage.getItem(PAD_MAP_ACTION_KEY);
    if (isPadMapAction(a)) padMapAction = a;
  } catch {
    /* ignore */
  }
}

function savePadMousePref() {
  try {
    localStorage.setItem(PAD_MOUSE_KEY, padMouseBtn);
    localStorage.setItem(PAD_MAP_ACTION_KEY, padMapAction);
  } catch {
    /* ignore */
  }
}

function setPadMouseEnabled(on: boolean) {
  try {
    localStorage.setItem(PAD_MOUSE_ON_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function isPadMouseEnabled(): boolean {
  try {
    return localStorage.getItem(PAD_MOUSE_ON_KEY) === "1";
  } catch {
    return false;
  }
}

function setPadMapStatus(state: "ok" | "err" | "busy" | "idle", msg: string) {
  const el = document.getElementById("pad-map-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `kickstart-status field-status${
    state === "ok" ? " ok" : state === "err" ? " err" : state === "busy" ? " busy" : ""
  }`;
}

function padMouseLabel(id: string): string {
  return PAD_MOUSE_BUTTONS.find((b) => b.id === id)?.label || id.toUpperCase();
}

function padMapActionLabel(id: PadMapAction = padMapAction): string {
  return PAD_MAP_ACTIONS.find((a) => a.id === id)?.short || id.toUpperCase();
}

function setPadMapAction(action: PadMapAction) {
  padMapAction = action;
  savePadMousePref();
  const sel = document.getElementById("pad-map-action") as HTMLSelectElement | null;
  if (sel && sel.value !== action) sel.value = action;
  updatePadMapUi();
}

function updatePadMapUi() {
  const cur = document.getElementById("pad-map-current");
  const lab = padMouseLabel(padMouseBtn);
  const desc = PAD_MOUSE_BUTTONS.find((b) => b.id === padMouseBtn)?.desc || "";
  const act = padMapActionLabel();
  if (cur) {
    cur.textContent = `${act} ← ${lab}${desc ? ` · ${desc}` : ""}`;
  }
  const sel = document.getElementById("pad-map-action") as HTMLSelectElement | null;
  if (sel && sel.value !== padMapAction) sel.value = padMapAction;

  document.querySelectorAll<HTMLButtonElement>("[data-pad-btn]").forEach((b) => {
    b.classList.toggle("active", b.dataset.padBtn === padMouseBtn);
  });
  document.querySelectorAll<SVGElement>(".pad-btn").forEach((el) => {
    const on = el.dataset.padBtn === padMouseBtn;
    el.classList.toggle("is-mapped", on);
    el.classList.toggle("is-lmb", on); // legacy class for older CSS
  });
  document.querySelectorAll<SVGTextElement>(".pad-label").forEach((el) => {
    const on = el.dataset.padBtn === padMouseBtn;
    el.classList.toggle("is-mapped", on);
    el.classList.toggle("is-lmb", on);
  });
}

/**
 * Diagram styles — top manufacturer layouts (shared LMB click targets:
 * l1/l2/r1/r2/l3/r3/select/start).
 */
type PadDiagramStyle = "nova" | "playstation" | "xbox" | "switch" | "eightbitdo";
const PAD_STYLE_KEY = "ra-pad-diagram-style";
const PAD_DIAGRAM_STYLES: PadDiagramStyle[] = [
  "nova",
  "playstation",
  "xbox",
  "switch",
  "eightbitdo",
];
const PAD_DIAGRAM_META: Record<
  PadDiagramStyle,
  { chip: string; className: string; svg: () => string }
> = {
  nova: {
    chip: "GameSir",
    className: "pad-diagram-nova",
    svg: () => svgPadNovaLite2(),
  },
  playstation: {
    chip: "PlayStation",
    className: "pad-diagram-ps",
    svg: () => svgPadDualSense(),
  },
  xbox: {
    chip: "Xbox",
    className: "pad-diagram-xbox",
    svg: () => svgPadXbox(),
  },
  switch: {
    chip: "Switch Pro",
    className: "pad-diagram-switch",
    svg: () => svgPadSwitchPro(),
  },
  eightbitdo: {
    chip: "8BitDo",
    className: "pad-diagram-8bitdo",
    svg: () => svgPadEightBitDo(),
  },
};
let padDiagramStyle: PadDiagramStyle = "nova";

function isPadDiagramStyle(v: string | null | undefined): v is PadDiagramStyle {
  return !!v && (PAD_DIAGRAM_STYLES as string[]).includes(v);
}

function loadPadDiagramStyle() {
  try {
    const v = localStorage.getItem(PAD_STYLE_KEY);
    // Migrate old "classic" → 8BitDo-style generic
    if (v === "classic") padDiagramStyle = "eightbitdo";
    else if (isPadDiagramStyle(v)) padDiagramStyle = v;
  } catch {
    /* ignore */
  }
}

function savePadDiagramStyle() {
  try {
    localStorage.setItem(PAD_STYLE_KEY, padDiagramStyle);
  } catch {
    /* ignore */
  }
}

function setPadDiagramStyle(style: PadDiagramStyle) {
  padDiagramStyle = style;
  savePadDiagramStyle();
  document.querySelectorAll<HTMLButtonElement>("[data-pad-style]").forEach((b) => {
    const on = b.dataset.padStyle === style;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  renderPadMapDiagram();
  updatePadMapUi();
}

/** Shared mappable-button label strip (all layouts use same RA button ids). */
function svgPadMapLabels(opts?: {
  l2?: [number, number];
  r2?: [number, number];
  l1?: [number, number];
  r1?: [number, number];
  l3?: [number, number];
  r3?: [number, number];
  select?: [number, number];
  start?: [number, number];
  selectText?: string;
  startText?: string;
  brandY?: number;
  brand?: string;
  fill?: string;
}): string {
  const f = opts?.fill ?? "#9aa4b8";
  const l2 = opts?.l2 ?? [140, 14];
  const r2 = opts?.r2 ?? [280, 14];
  const l1 = opts?.l1 ?? [140, 40];
  const r1 = opts?.r1 ?? [280, 40];
  const l3 = opts?.l3 ?? [130, 200];
  const r3 = opts?.r3 ?? [290, 200];
  const sel = opts?.select ?? [175, 72];
  const st = opts?.start ?? [245, 72];
  const brandY = opts?.brandY ?? 268;
  const brand = opts?.brand ?? "";
  return `
  <text class="pad-label" data-pad-btn="l2" x="${l2[0]}" y="${l2[1]}" text-anchor="middle" fill="${f}" font-size="10" font-weight="700">L2</text>
  <text class="pad-label" data-pad-btn="r2" x="${r2[0]}" y="${r2[1]}" text-anchor="middle" fill="${f}" font-size="10" font-weight="700">R2</text>
  <text class="pad-label" data-pad-btn="l1" x="${l1[0]}" y="${l1[1]}" text-anchor="middle" fill="${f}" font-size="10" font-weight="700">L1</text>
  <text class="pad-label" data-pad-btn="r1" x="${r1[0]}" y="${r1[1]}" text-anchor="middle" fill="${f}" font-size="10" font-weight="700">R1</text>
  <text class="pad-label" data-pad-btn="l3" x="${l3[0]}" y="${l3[1]}" text-anchor="middle" fill="${f}" font-size="9" font-weight="700">L3</text>
  <text class="pad-label" data-pad-btn="r3" x="${r3[0]}" y="${r3[1]}" text-anchor="middle" fill="${f}" font-size="9" font-weight="700">R3</text>
  <text class="pad-label" data-pad-btn="select" x="${sel[0]}" y="${sel[1]}" text-anchor="middle" fill="${f}" font-size="8" font-weight="700">${opts?.selectText ?? "Select"}</text>
  <text class="pad-label" data-pad-btn="start" x="${st[0]}" y="${st[1]}" text-anchor="middle" fill="${f}" font-size="8" font-weight="700">${opts?.startText ?? "Start"}</text>
  ${brand ? `<text x="210" y="${brandY}" text-anchor="middle" fill="${f}" font-size="9" font-weight="600" font-family="system-ui,sans-serif" opacity="0.85">${brand}</text>` : ""}`;
}

/**
 * GameSir Nova Lite 2 — matte charcoal Xbox-layout, orange stick rings,
 * black face buttons with orange letters, circular d-pad.
 */
function svgPadNovaLite2(): string {
  return `
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GameSir Nova Lite 2 gamepad">
  <defs>
    <linearGradient id="gsBody" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4a4e54"/>
      <stop offset="40%" stop-color="#3a3e44"/>
      <stop offset="100%" stop-color="#2a2e34"/>
    </linearGradient>
    <linearGradient id="gsFace" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#52565c"/>
      <stop offset="100%" stop-color="#3c4046"/>
    </linearGradient>
    <linearGradient id="gsStick" x1="30%" y1="20%" x2="70%" y2="90%">
      <stop offset="0%" stop-color="#2a2c30"/>
      <stop offset="100%" stop-color="#0e1014"/>
    </linearGradient>
    <radialGradient id="gsBtn" cx="40%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#2c2e32"/>
      <stop offset="100%" stop-color="#121416"/>
    </radialGradient>
    <filter id="gsSoft" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.4"/>
    </filter>
  </defs>
  <path filter="url(#gsSoft)" fill="url(#gsBody)" stroke="#5a5e64" stroke-width="1.2"
    d="M 78 92 C 72 52, 110 36, 150 34 L 270 34 C 310 36, 348 52, 342 92
       C 348 118, 358 148, 372 178 C 388 214, 378 248, 348 256
       C 318 264, 292 248, 280 220 L 140 220 C 128 248, 102 264, 72 256
       C 42 248, 32 214, 48 178 C 62 148, 72 118, 78 92 Z"/>
  <path fill="url(#gsFace)" opacity="0.55"
    d="M 108 58 C 120 44, 150 40, 175 40 L 245 40 C 270 40, 300 44, 312 58
       C 318 78, 316 100, 310 118 C 300 108, 270 102, 210 102
       C 150 102, 120 108, 110 118 C 104 100, 102 78, 108 58 Z"/>
  <path class="pad-btn" data-pad-btn="l2"
    d="M118 20 C122 14, 150 12, 168 14 L170 28 C152 26, 128 28, 120 32 Z"
    fill="#1a1c20" stroke="#6a6e74" stroke-width="1"/>
  <path class="pad-btn" data-pad-btn="r2"
    d="M252 14 C270 12, 298 14, 302 20 L300 32 C292 28, 268 26, 250 28 Z"
    fill="#1a1c20" stroke="#6a6e74" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="l1" x="118" y="32" width="54" height="12" rx="5"
    fill="#22262c" stroke="#6a6e74" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="r1" x="248" y="32" width="54" height="12" rx="5"
    fill="#22262c" stroke="#6a6e74" stroke-width="1"/>
  <circle cx="132" cy="96" r="26" fill="none" stroke="#e85a2a" stroke-width="3.2" opacity="0.95"/>
  <circle class="pad-btn" data-pad-btn="l3" cx="132" cy="96" r="21"
    fill="url(#gsStick)" stroke="#1a1c20" stroke-width="1"/>
  <circle cx="132" cy="96" r="12" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="132" cy="96" r="4" fill="#4a4e54"/>
  <circle cx="248" cy="148" r="26" fill="none" stroke="#e85a2a" stroke-width="3.2" opacity="0.95"/>
  <circle class="pad-btn" data-pad-btn="r3" cx="248" cy="148" r="21"
    fill="url(#gsStick)" stroke="#1a1c20" stroke-width="1"/>
  <circle cx="248" cy="148" r="12" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="248" cy="148" r="4" fill="#4a4e54"/>
  <circle cx="132" cy="158" r="24" fill="#1a1c20" stroke="#2a2e34" stroke-width="1.5"/>
  <g fill="#0e1014" stroke="#2a2e34" stroke-width="0.6">
    <path d="M132 140 L140 150 L132 148 L124 150 Z"/>
    <path d="M132 176 L140 166 L132 168 L124 166 Z"/>
    <path d="M114 158 L124 150 L122 158 L124 166 Z"/>
    <path d="M150 158 L140 150 L142 158 L140 166 Z"/>
  </g>
  <circle cx="132" cy="158" r="5" fill="#25282e"/>
  <g>
    <circle cx="300" cy="78" r="12.5" fill="url(#gsBtn)" stroke="#1a1c20" stroke-width="1"/>
    <circle cx="322" cy="100" r="12.5" fill="url(#gsBtn)" stroke="#1a1c20" stroke-width="1"/>
    <circle cx="278" cy="100" r="12.5" fill="url(#gsBtn)" stroke="#1a1c20" stroke-width="1"/>
    <circle cx="300" cy="122" r="12.5" fill="url(#gsBtn)" stroke="#1a1c20" stroke-width="1"/>
    <text x="300" y="83" text-anchor="middle" fill="#e85a2a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">Y</text>
    <text x="322" y="105" text-anchor="middle" fill="#e85a2a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">B</text>
    <text x="278" y="105" text-anchor="middle" fill="#e85a2a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">X</text>
    <text x="300" y="127" text-anchor="middle" fill="#e85a2a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">A</text>
  </g>
  <g class="pad-btn" data-pad-btn="select">
    <rect x="176" y="78" width="16" height="11" rx="3" fill="#1a1c20" stroke="#3a3e44" stroke-width="1"/>
    <rect x="178.5" y="80.5" width="4" height="6" rx="0.8" fill="#6a6e74"/>
    <rect x="185.5" y="80.5" width="4" height="6" rx="0.8" fill="#6a6e74"/>
  </g>
  <g class="pad-btn" data-pad-btn="start">
    <rect x="228" y="78" width="16" height="11" rx="3" fill="#1a1c20" stroke="#3a3e44" stroke-width="1"/>
    <rect x="231" y="81" width="10" height="1.6" rx="0.6" fill="#6a6e74"/>
    <rect x="231" y="84.8" width="10" height="1.6" rx="0.6" fill="#6a6e74"/>
  </g>
  <ellipse cx="210" cy="102" rx="10" ry="7" fill="#1a1c20" stroke="#3a3e44" stroke-width="1.2"/>
  <ellipse cx="210" cy="102" rx="4" ry="2.5" fill="#4a4e54"/>
  <ellipse cx="210" cy="168" rx="9" ry="6.5" fill="#1a1c20" stroke="#3a3e44" stroke-width="1"/>
  <text x="210" y="171" text-anchor="middle" fill="#8a8e94" font-size="8" font-weight="700" font-family="system-ui,sans-serif">M</text>
  <path d="M68 200 C62 220, 70 242, 90 248" fill="none" stroke="#2a2e34" stroke-width="4" stroke-linecap="round" opacity="0.5"/>
  <path d="M352 200 C358 220, 350 242, 330 248" fill="none" stroke="#2a2e34" stroke-width="4" stroke-linecap="round" opacity="0.5"/>
  ${svgPadMapLabels({
    l2: [143, 14],
    r2: [277, 14],
    l1: [145, 42],
    r1: [275, 42],
    l3: [132, 72],
    r3: [248, 185],
    select: [184, 72],
    start: [236, 72],
    selectText: "View",
    startText: "Menu",
    brand: "GameSir Nova Lite 2",
    fill: "#c8a090",
  })}
</svg>`;
}

/** Sony DualSense — white body, △○✕□ face, sticks low, touchpad center. */
function svgPadDualSense(): string {
  return `
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PlayStation DualSense gamepad">
  <defs>
    <linearGradient id="psBody" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f2f4f6"/>
      <stop offset="55%" stop-color="#e4e8ec"/>
      <stop offset="100%" stop-color="#c8ced6"/>
    </linearGradient>
    <linearGradient id="psDark" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#2a2e34"/>
      <stop offset="100%" stop-color="#121416"/>
    </linearGradient>
    <filter id="psSoft" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <!-- DualSense continuous shell -->
  <path filter="url(#psSoft)" fill="url(#psBody)" stroke="#a8b0b8" stroke-width="1.2"
    d="M 88 78 C 80 42, 118 28, 158 28 L 262 28 C 302 28, 340 42, 332 78
       C 340 110, 356 150, 368 182 C 382 220, 368 250, 332 252
       C 300 254, 278 236, 268 210 L 152 210 C 142 236, 120 254, 88 252
       C 52 250, 38 220, 52 182 C 64 150, 80 110, 88 78 Z"/>
  <!-- Dark face plate / grips accent -->
  <path fill="#1e2228" opacity="0.12"
    d="M 100 70 C 110 48, 150 44, 180 44 L 240 44 C 270 44, 310 48, 320 70
       C 324 92, 320 110, 314 122 C 300 112, 260 108, 210 108 C 160 108, 120 112, 106 122
       C 100 110, 96 92, 100 70 Z"/>
  <!-- L2 / R2 adaptive-trigger style -->
  <path class="pad-btn" data-pad-btn="l2"
    d="M120 16 C126 10, 152 8, 172 12 L174 26 C154 22, 132 24, 122 30 Z"
    fill="#2a2e34" stroke="#5a6068" stroke-width="1"/>
  <path class="pad-btn" data-pad-btn="r2"
    d="M248 12 C268 8, 294 10, 300 16 L298 30 C288 24, 266 22, 246 26 Z"
    fill="#2a2e34" stroke="#5a6068" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="l1" x="118" y="30" width="56" height="12" rx="4"
    fill="#3a3e44" stroke="#5a6068" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="r1" x="246" y="30" width="56" height="12" rx="4"
    fill="#3a3e44" stroke="#5a6068" stroke-width="1"/>
  <!-- Touchpad -->
  <rect x="158" y="62" width="104" height="48" rx="8" fill="#d8dde4" stroke="#a8b0b8" stroke-width="1.2"/>
  <rect x="164" y="68" width="92" height="36" rx="5" fill="#eef1f4" stroke="#c0c6ce" stroke-width="0.8"/>
  <!-- Create (select) / Options (start) -->
  <g class="pad-btn" data-pad-btn="select">
    <rect x="138" y="78" width="14" height="10" rx="2" fill="#2a2e34"/>
    <rect x="141" y="81" width="3" height="4" fill="#8a9098"/>
    <rect x="146" y="81" width="3" height="4" fill="#8a9098"/>
  </g>
  <g class="pad-btn" data-pad-btn="start">
    <rect x="268" y="78" width="14" height="10" rx="2" fill="#2a2e34"/>
    <path d="M271 81 L279 83 L271 85 Z" fill="#8a9098"/>
  </g>
  <!-- PS button -->
  <circle cx="210" cy="128" r="9" fill="#1a1c20" stroke="#3a3e44" stroke-width="1"/>
  <text x="210" y="131.5" text-anchor="middle" fill="#c8ccd0" font-size="8" font-weight="700" font-family="system-ui,sans-serif">PS</text>
  <!-- Mute mic (visual) -->
  <rect x="202" y="148" width="16" height="8" rx="3" fill="#2a2e34"/>
  <!-- D-pad high left -->
  <g fill="#2a2e34" stroke="#1a1c20" stroke-width="0.8">
    <rect x="108" y="78" width="16" height="46" rx="3"/>
    <rect x="93" y="93" width="46" height="16" rx="3"/>
  </g>
  <!-- Face: △ ○ ✕ □ (green / red / blue / pink) -->
  <circle cx="300" cy="78" r="11" fill="#1a1c20"/>
  <circle cx="322" cy="100" r="11" fill="#1a1c20"/>
  <circle cx="278" cy="100" r="11" fill="#1a1c20"/>
  <circle cx="300" cy="122" r="11" fill="#1a1c20"/>
  <text x="300" y="82" text-anchor="middle" fill="#2ecc71" font-size="12" font-weight="700">△</text>
  <text x="322" y="105" text-anchor="middle" fill="#e74c3c" font-size="13" font-weight="700">○</text>
  <text x="278" y="105" text-anchor="middle" fill="#e91e8c" font-size="11" font-weight="700">□</text>
  <text x="300" y="127" text-anchor="middle" fill="#3498db" font-size="14" font-weight="700">✕</text>
  <!-- Sticks low (PS layout) L3 / R3 -->
  <circle class="pad-btn" data-pad-btn="l3" cx="148" cy="158" r="22" fill="url(#psDark)" stroke="#3a3e44" stroke-width="1.5"/>
  <circle cx="148" cy="158" r="11" fill="none" stroke="#5a6068" stroke-width="1.2"/>
  <circle cx="148" cy="158" r="4" fill="#6a7078"/>
  <circle class="pad-btn" data-pad-btn="r3" cx="272" cy="158" r="22" fill="url(#psDark)" stroke="#3a3e44" stroke-width="1.5"/>
  <circle cx="272" cy="158" r="11" fill="none" stroke="#5a6068" stroke-width="1.2"/>
  <circle cx="272" cy="158" r="4" fill="#6a7078"/>
  ${svgPadMapLabels({
    l2: [145, 12],
    r2: [275, 12],
    l1: [146, 40],
    r1: [274, 40],
    l3: [148, 195],
    r3: [272, 195],
    select: [145, 72],
    start: [275, 72],
    selectText: "Create",
    startText: "Options",
    brand: "PlayStation DualSense",
    fill: "#4a5560",
  })}
</svg>`;
}

/** Microsoft Xbox Series — black shell, colored ABXY, asymmetric sticks. */
function svgPadXbox(): string {
  return `
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Xbox Series gamepad">
  <defs>
    <linearGradient id="xbBody" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#2c2e32"/>
      <stop offset="50%" stop-color="#1a1c20"/>
      <stop offset="100%" stop-color="#0e1014"/>
    </linearGradient>
    <filter id="xbSoft" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <path filter="url(#xbSoft)" fill="url(#xbBody)" stroke="#3a3e44" stroke-width="1.3"
    d="M 82 88 C 74 48, 112 30, 152 28 L 268 28 C 308 30, 346 48, 338 88
       C 348 120, 362 152, 378 186 C 396 226, 378 254, 342 258
       C 308 262, 286 240, 276 214 L 144 214 C 134 240, 112 262, 78 258
       C 42 254, 24 226, 42 186 C 58 152, 72 120, 82 88 Z"/>
  <!-- L2 / R2 -->
  <path class="pad-btn" data-pad-btn="l2"
    d="M122 16 C128 10, 154 8, 172 12 L174 28 C154 24, 132 26, 124 32 Z"
    fill="#0a0c10" stroke="#4a4e54" stroke-width="1"/>
  <path class="pad-btn" data-pad-btn="r2"
    d="M248 12 C266 8, 292 10, 298 16 L296 32 C288 26, 266 24, 246 28 Z"
    fill="#0a0c10" stroke="#4a4e54" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="l1" x="120" y="32" width="54" height="12" rx="4"
    fill="#1a1c20" stroke="#4a4e54" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="r1" x="246" y="32" width="54" height="12" rx="4"
    fill="#1a1c20" stroke="#4a4e54" stroke-width="1"/>
  <!-- Share (visual) -->
  <circle cx="210" cy="58" r="6" fill="#0a0c10" stroke="#3a3e44" stroke-width="1"/>
  <!-- View / Menu -->
  <g class="pad-btn" data-pad-btn="select">
    <rect x="172" y="78" width="16" height="11" rx="2" fill="#0a0c10" stroke="#4a4e54"/>
    <rect x="175" y="81" width="4" height="5" fill="#6a7078"/>
    <rect x="181" y="81" width="4" height="5" fill="#6a7078"/>
  </g>
  <g class="pad-btn" data-pad-btn="start">
    <rect x="232" y="78" width="16" height="11" rx="2" fill="#0a0c10" stroke="#4a4e54"/>
    <rect x="235" y="81" width="10" height="1.5" fill="#6a7078"/>
    <rect x="235" y="84.5" width="10" height="1.5" fill="#6a7078"/>
  </g>
  <!-- Xbox button -->
  <circle cx="210" cy="102" r="12" fill="#0a0c10" stroke="#107c10" stroke-width="1.8"/>
  <circle cx="210" cy="102" r="5" fill="#107c10" opacity="0.85"/>
  <!-- Left stick high left L3 -->
  <circle class="pad-btn" data-pad-btn="l3" cx="138" cy="98" r="23" fill="#0a0c10" stroke="#4a4e54" stroke-width="1.5"/>
  <circle cx="138" cy="98" r="12" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="138" cy="98" r="4" fill="#5a6068"/>
  <!-- D-pad lower left -->
  <g fill="#0a0c10" stroke="#3a3e44" stroke-width="1">
    <rect x="124" y="138" width="16" height="44" rx="3"/>
    <rect x="110" y="152" width="44" height="16" rx="3"/>
  </g>
  <!-- Right stick lower mid R3 -->
  <circle class="pad-btn" data-pad-btn="r3" cx="248" cy="150" r="23" fill="#0a0c10" stroke="#4a4e54" stroke-width="1.5"/>
  <circle cx="248" cy="150" r="12" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="248" cy="150" r="4" fill="#5a6068"/>
  <!-- Colored ABXY -->
  <circle cx="302" cy="80" r="12" fill="#f1c40f" stroke="#d4a80a" stroke-width="1"/>
  <circle cx="324" cy="102" r="12" fill="#e74c3c" stroke="#c0392b" stroke-width="1"/>
  <circle cx="280" cy="102" r="12" fill="#3498db" stroke="#2980b9" stroke-width="1"/>
  <circle cx="302" cy="124" r="12" fill="#2ecc71" stroke="#27ae60" stroke-width="1"/>
  <text x="302" y="85" text-anchor="middle" fill="#1a1a1a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">Y</text>
  <text x="324" y="107" text-anchor="middle" fill="#1a1a1a" font-size="11" font-weight="800" font-family="system-ui,sans-serif">B</text>
  <text x="280" y="107" text-anchor="middle" fill="#fff" font-size="11" font-weight="800" font-family="system-ui,sans-serif">X</text>
  <text x="302" y="129" text-anchor="middle" fill="#fff" font-size="11" font-weight="800" font-family="system-ui,sans-serif">A</text>
  ${svgPadMapLabels({
    l2: [146, 12],
    r2: [274, 12],
    l1: [147, 42],
    r1: [273, 42],
    l3: [138, 74],
    r3: [248, 188],
    select: [180, 72],
    start: [240, 72],
    selectText: "View",
    startText: "Menu",
    brand: "Xbox Series",
    fill: "#8a9098",
  })}
</svg>`;
}

/** Nintendo Switch Pro — charcoal, neon ABXY, sticks mid-height, Home + Capture. */
function svgPadSwitchPro(): string {
  return `
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nintendo Switch Pro Controller">
  <defs>
    <linearGradient id="swBody" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#3a3e44"/>
      <stop offset="100%" stop-color="#1e2228"/>
    </linearGradient>
    <filter id="swSoft" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.4"/>
    </filter>
  </defs>
  <path filter="url(#swSoft)" fill="url(#swBody)" stroke="#4a4e54" stroke-width="1.2"
    d="M 90 80 C 84 44, 120 30, 160 28 L 260 28 C 300 30, 336 44, 330 80
       C 340 118, 354 156, 366 188 C 380 224, 364 250, 330 252
       C 300 254, 282 236, 274 212 L 146 212 C 138 236, 120 254, 90 252
       C 56 250, 40 224, 54 188 C 66 156, 80 118, 90 80 Z"/>
  <path class="pad-btn" data-pad-btn="l2"
    d="M124 16 C130 10, 154 8, 172 12 L174 26 C154 22, 134 24, 126 30 Z"
    fill="#121416" stroke="#5a5e64" stroke-width="1"/>
  <path class="pad-btn" data-pad-btn="r2"
    d="M248 12 C266 8, 290 10, 296 16 L294 30 C286 24, 266 22, 246 26 Z"
    fill="#121416" stroke="#5a5e64" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="l1" x="120" y="30" width="56" height="12" rx="4"
    fill="#1a1c20" stroke="#5a5e64" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="r1" x="244" y="30" width="56" height="12" rx="4"
    fill="#1a1c20" stroke="#5a5e64" stroke-width="1"/>
  <!-- Minus (select) / Plus (start) -->
  <g class="pad-btn" data-pad-btn="select">
    <circle cx="168" cy="78" r="8" fill="#121416" stroke="#4a4e54"/>
    <rect x="162" y="76.5" width="12" height="3" rx="1" fill="#c8ccd0"/>
  </g>
  <g class="pad-btn" data-pad-btn="start">
    <circle cx="252" cy="78" r="8" fill="#121416" stroke="#4a4e54"/>
    <rect x="246" y="76.5" width="12" height="3" rx="1" fill="#c8ccd0"/>
    <rect x="250.5" y="72" width="3" height="12" rx="1" fill="#c8ccd0"/>
  </g>
  <!-- Capture + Home -->
  <rect x="188" y="118" width="14" height="14" rx="2" fill="#121416" stroke="#4a4e54"/>
  <circle cx="230" cy="125" r="9" fill="#121416" stroke="#e60012" stroke-width="1.5"/>
  <circle cx="230" cy="125" r="3.5" fill="#e60012" opacity="0.7"/>
  <!-- Left stick mid-left L3 -->
  <circle class="pad-btn" data-pad-btn="l3" cx="140" cy="112" r="22" fill="#121416" stroke="#4a4e54" stroke-width="1.5"/>
  <circle cx="140" cy="112" r="11" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="140" cy="112" r="4" fill="#5a6068"/>
  <!-- D-pad lower left -->
  <g fill="#121416" stroke="#3a3e44" stroke-width="1">
    <rect x="126" y="148" width="16" height="42" rx="3"/>
    <rect x="113" y="161" width="42" height="16" rx="3"/>
  </g>
  <!-- Right stick mid-right R3 -->
  <circle class="pad-btn" data-pad-btn="r3" cx="280" cy="112" r="22" fill="#121416" stroke="#4a4e54" stroke-width="1.5"/>
  <circle cx="280" cy="112" r="11" fill="none" stroke="#3a3e44" stroke-width="1.2"/>
  <circle cx="280" cy="112" r="4" fill="#5a6068"/>
  <!-- ABXY neon (Switch: B bottom, A right, Y left, X top — use Xbox lettering for RA) -->
  <circle cx="300" cy="148" r="12" fill="#1a1c20" stroke="#2ecc71" stroke-width="1.5"/>
  <circle cx="322" cy="170" r="12" fill="#1a1c20" stroke="#e74c3c" stroke-width="1.5"/>
  <circle cx="278" cy="170" r="12" fill="#1a1c20" stroke="#f1c40f" stroke-width="1.5"/>
  <circle cx="300" cy="192" r="12" fill="#1a1c20" stroke="#3498db" stroke-width="1.5"/>
  <text x="300" y="153" text-anchor="middle" fill="#2ecc71" font-size="10" font-weight="800" font-family="system-ui,sans-serif">X</text>
  <text x="322" y="175" text-anchor="middle" fill="#e74c3c" font-size="10" font-weight="800" font-family="system-ui,sans-serif">A</text>
  <text x="278" y="175" text-anchor="middle" fill="#f1c40f" font-size="10" font-weight="800" font-family="system-ui,sans-serif">Y</text>
  <text x="300" y="197" text-anchor="middle" fill="#3498db" font-size="10" font-weight="800" font-family="system-ui,sans-serif">B</text>
  ${svgPadMapLabels({
    l2: [146, 12],
    r2: [274, 12],
    l1: [148, 40],
    r1: [272, 40],
    l3: [140, 88],
    r3: [280, 88],
    select: [168, 64],
    start: [252, 64],
    selectText: "−",
    startText: "+",
    brand: "Nintendo Switch Pro",
    fill: "#a0a8b0",
  })}
</svg>`;
}

/**
 * 8BitDo Ultimate / Pro 2 vibe — purple-tinted retro-modern, SNES-style face
 * colors, dual sticks (common with RetroArch / Bluetooth pads).
 */
function svgPadEightBitDo(): string {
  return `
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="8BitDo style gamepad">
  <defs>
    <linearGradient id="ebBody" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#3d3548"/>
      <stop offset="50%" stop-color="#2a2434"/>
      <stop offset="100%" stop-color="#1a1622"/>
    </linearGradient>
    <filter id="ebSoft" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.4"/>
    </filter>
  </defs>
  <path filter="url(#ebSoft)" fill="url(#ebBody)" stroke="#5a4e6a" stroke-width="1.3"
    d="M 78 85 C 72 48, 110 32, 155 30 L 265 30 C 310 32, 348 48, 342 85
       C 350 120, 362 155, 374 185 C 390 222, 372 252, 338 254
       C 308 256, 288 238, 278 212 L 142 212 C 132 238, 112 256, 82 254
       C 48 252, 30 222, 46 185 C 58 155, 70 120, 78 85 Z"/>
  <!-- Accent stripe (8BitDo signature) -->
  <path fill="#7c5cbf" opacity="0.35"
    d="M 120 48 L 300 48 L 298 58 L 122 58 Z"/>
  <path class="pad-btn" data-pad-btn="l2"
    d="M120 16 C126 10, 152 8, 170 12 L172 26 C152 22, 130 24, 122 30 Z"
    fill="#121018" stroke="#6a5a7a" stroke-width="1"/>
  <path class="pad-btn" data-pad-btn="r2"
    d="M250 12 C268 8, 294 10, 300 16 L298 30 C290 24, 268 22, 248 26 Z"
    fill="#121018" stroke="#6a5a7a" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="l1" x="118" y="30" width="54" height="12" rx="4"
    fill="#1e1a28" stroke="#6a5a7a" stroke-width="1"/>
  <rect class="pad-btn" data-pad-btn="r1" x="248" y="30" width="54" height="12" rx="4"
    fill="#1e1a28" stroke="#6a5a7a" stroke-width="1"/>
  <!-- Select / Start ovals -->
  <ellipse class="pad-btn" data-pad-btn="select" cx="175" cy="92" rx="14" ry="7"
    fill="#121018" stroke="#6a5a7a" stroke-width="1"/>
  <ellipse class="pad-btn" data-pad-btn="start" cx="245" cy="92" rx="14" ry="7"
    fill="#121018" stroke="#6a5a7a" stroke-width="1"/>
  <!-- Star / home -->
  <circle cx="210" cy="118" r="8" fill="#121018" stroke="#7c5cbf" stroke-width="1.5"/>
  <!-- D-pad left -->
  <g fill="#121018" stroke="#4a3e5a" stroke-width="1">
    <rect x="108" y="100" width="18" height="50" rx="3"/>
    <rect x="92" y="116" width="50" height="18" rx="3"/>
  </g>
  <!-- Sticks lower row (Pro 2 style) -->
  <circle class="pad-btn" data-pad-btn="l3" cx="150" cy="168" r="20" fill="#121018" stroke="#6a5a7a" stroke-width="1.5"/>
  <circle cx="150" cy="168" r="10" fill="none" stroke="#4a3e5a" stroke-width="1"/>
  <circle cx="150" cy="168" r="3.5" fill="#6a5a7a"/>
  <circle class="pad-btn" data-pad-btn="r3" cx="270" cy="168" r="20" fill="#121018" stroke="#6a5a7a" stroke-width="1.5"/>
  <circle cx="270" cy="168" r="10" fill="none" stroke="#4a3e5a" stroke-width="1"/>
  <circle cx="270" cy="168" r="3.5" fill="#6a5a7a"/>
  <!-- SNES-colored face (Y/X/B/A) -->
  <circle cx="300" cy="88" r="12" fill="#2ecc71" stroke="#27ae60" stroke-width="1"/>
  <circle cx="322" cy="110" r="12" fill="#e74c3c" stroke="#c0392b" stroke-width="1"/>
  <circle cx="278" cy="110" r="12" fill="#3498db" stroke="#2980b9" stroke-width="1"/>
  <circle cx="300" cy="132" r="12" fill="#f1c40f" stroke="#d4a80a" stroke-width="1"/>
  <text x="300" y="93" text-anchor="middle" fill="#0a0a0a" font-size="10" font-weight="800" font-family="system-ui,sans-serif">Y</text>
  <text x="322" y="115" text-anchor="middle" fill="#0a0a0a" font-size="10" font-weight="800" font-family="system-ui,sans-serif">B</text>
  <text x="278" y="115" text-anchor="middle" fill="#fff" font-size="10" font-weight="800" font-family="system-ui,sans-serif">X</text>
  <text x="300" y="137" text-anchor="middle" fill="#0a0a0a" font-size="10" font-weight="800" font-family="system-ui,sans-serif">A</text>
  ${svgPadMapLabels({
    l2: [144, 12],
    r2: [276, 12],
    l1: [145, 40],
    r1: [275, 40],
    l3: [150, 202],
    r3: [270, 202],
    select: [175, 78],
    start: [245, 78],
    selectText: "Select",
    startText: "Start",
    brand: "8BitDo Ultimate",
    fill: "#b8a8d0",
  })}
</svg>`;
}

function wirePadDiagramClicks(host: HTMLElement) {
  host.querySelectorAll<SVGElement>(".pad-btn").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.padBtn;
      if (!id) return;
      padMouseBtn = id;
      savePadMousePref();
      updatePadMapUi();
    });
  });
}

function renderPadMapDiagram() {
  const host = document.getElementById("pad-map-diagram");
  if (!host) return;
  const meta = PAD_DIAGRAM_META[padDiagramStyle] ?? PAD_DIAGRAM_META.nova;
  host.innerHTML = meta.svg();
  for (const s of PAD_DIAGRAM_STYLES) {
    host.classList.toggle(PAD_DIAGRAM_META[s].className, s === padDiagramStyle);
  }
  // Drop legacy class if present
  host.classList.remove("pad-diagram-classic");
  wirePadDiagramClicks(host);
}

function renderPadMapChoices() {
  const box = document.getElementById("pad-map-choices");
  if (!box) return;
  box.innerHTML = "";
  for (const b of PAD_MOUSE_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary small";
    btn.dataset.padBtn = b.id;
    btn.textContent = b.label;
    btn.title = b.desc;
    btn.addEventListener("click", () => {
      padMouseBtn = b.id;
      savePadMousePref();
      updatePadMapUi();
    });
    box.appendChild(btn);
  }
}

function renderPadStyleChips() {
  const bar = document.querySelector(".pad-map-style-bar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const s of PAD_DIAGRAM_STYLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pad-style-chip" + (s === padDiagramStyle ? " active" : "");
    b.dataset.padStyle = s;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", s === padDiagramStyle ? "true" : "false");
    b.textContent = PAD_DIAGRAM_META[s].chip;
    b.title = PAD_DIAGRAM_META[s].chip + " layout";
    b.addEventListener("click", () => setPadDiagramStyle(s));
    bar.appendChild(b);
  }
}

function initPadMapUi() {
  loadPadMousePref();
  loadPadDiagramStyle();
  const actionSel = document.getElementById(
    "pad-map-action",
  ) as HTMLSelectElement | null;
  if (actionSel) actionSel.value = padMapAction;
  renderPadStyleChips();
  renderPadMapDiagram();
  renderPadMapChoices();
  updatePadMapUi();
}

async function applyPadMouseMapping() {
  const act = padMapActionLabel();
  setPadMapStatus(
    "busy",
    `Starting mapper on TV (${act} ← ${padMouseLabel(padMouseBtn)})…`,
  );
  log(`Pad mapping: applying ${act} ← ${padMouseBtn}…`);
  try {
    const settings = readForm();
    // Preflight: explain clearly when only Magic Remote / no GameSir is present
    let padMissing = false;
    try {
      const padsOut = await invoke<string>("ra_list_gamepads", { settings });
      const { pads, none, hint } = parseGamepadList(padsOut || "");
      if (pads.length) {
        setPadBadge("ok", pads);
        log(
          `Pad(s) on TV: ${pads.map((p) => p.name).join(", ")}`,
        );
      } else {
        padMissing = true;
        setPadBadge("missing");
        log(
          none ||
            "No Bluetooth gamepad on the TV (only Magic Remote / LGE devices).",
          true,
        );
        if (hint) log(hint, true);
        log(
          "Pair the GameSir on the TV (not this Mac):\n" +
            "  1) TV Settings → All Settings → Connections → Bluetooth\n" +
            "  2) Put GameSir in pairing mode, connect it\n" +
            "  3) Press a button on the pad to wake it\n" +
            "  4) Detect gamepad (should show GameSir/Nova), then Apply again",
          true,
        );
        setPadMapStatus(
          "err",
          "No gamepad on TV — pair GameSir on TV Bluetooth, wake it, Detect, Apply",
        );
        return;
      }
    } catch {
      /* continue anyway */
    }
    const out = await invoke<string>("ra_pad_mouse_start", {
      settings,
      button: padMouseBtn,
      action: padMapAction,
    });
    setConnBadge("ok", `${settings.user}@${settings.host}`);
    if (out?.trim()) log(out.trimEnd());
    savePadMousePref();
    setPadMouseEnabled(true);
    setPadMapStatus(
      "ok",
      `✓ Active — press ${padMouseLabel(padMouseBtn)} for ${act.toLowerCase()}`,
    );
    log(
      `Pad→${act} active: ${padMouseLabel(padMouseBtn)}. ` +
        (padMissing
          ? "Wake/pair the pad on the TV, then press the mapped button."
          : "Press that button on the pad to inject the click."),
    );
  } catch (e) {
    const err = formatError(e);
    log(err, true);
    if (/no gamepad/i.test(err)) {
      log(
        "Mapper exited: still no Bluetooth pad on the TV. Pair GameSir under TV Bluetooth (not Mac Bluetooth), wake it, Detect, then Apply.",
        true,
      );
      setPadMapStatus(
        "err",
        "No gamepad on TV — pair GameSir on TV Bluetooth, wake it, Apply",
      );
    } else {
      setPadMapStatus("err", summarizeError(err, 100));
    }
    setConnBadge("err", summarizeError(err), err);
  }
}

async function stopPadMouseMapping() {
  setPadMapStatus("busy", "Stopping mapper…");
  try {
    const out = await invoke<string>("ra_pad_mouse_stop", {
      settings: readForm(),
    });
    if (out?.trim()) log(out.trimEnd());
    setPadMouseEnabled(false);
    setPadMapStatus("idle", "Disabled — no pad→click mapping");
    log("Pad→mouse mapper stopped.");
  } catch (e) {
    const err = formatError(e);
    log(err, true);
    setPadMapStatus("err", summarizeError(err, 100));
  }
}

/** True if this pad line is our GameSir (incl. PS4-mode "Wireless Controller"). */
function isGameSirPadName(name: string): boolean {
  return /gamesir|game.?sir|nova|wireless\s*controller|ps4\s*controller/i.test(
    name || "",
  );
}

/** Parse `pad|name|event|js|score` (or legacy `pad|name`) lines from list-gamepads. */
function parseGamepadList(raw: string): {
  pads: { name: string; detail: string }[];
  none: string | null;
  hint: string | null;
} {
  const pads: { name: string; detail: string }[] = [];
  let none: string | null = null;
  let hint: string | null = null;
  for (const line of (raw || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("pad|")) {
      const parts = t.slice(4).split("|");
      let name = (parts[0] || "").trim();
      if (!name) continue;
      // list-gamepads may already send "GameSir (PS4 mode)"; normalize raw HID names.
      if (/^wireless\s*controller$/i.test(name) || /^ps4\s*controller$/i.test(name)) {
        name = "GameSir (PS4 mode)";
      }
      const rest = parts
        .slice(1)
        .map((p) => p.trim())
        .filter(Boolean);
      pads.push({
        name,
        detail: rest.length ? rest.join(" · ") : "",
      });
    } else if (t.startsWith("none|")) {
      none = t.slice(5).trim() || none;
    } else if (t.startsWith("hint|")) {
      hint = t.slice(5).trim() || hint;
    }
  }
  return { pads, none, hint };
}

/** Remember last live pad names (Mac-side only — BT bond itself lives on the TV). */
const PAD_LAST_NAMES_KEY = "ra-last-gamepad-names";

function rememberLivePads(pads: { name: string }[]) {
  if (!pads.length) return;
  try {
    localStorage.setItem(
      PAD_LAST_NAMES_KEY,
      JSON.stringify(pads.map((p) => p.name).filter(Boolean)),
    );
  } catch {
    /* ignore */
  }
}

function lastKnownPadNames(): string[] {
  try {
    const raw = localStorage.getItem(PAD_LAST_NAMES_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j)
      ? j.filter((x): x is string => typeof x === "string" && !!x.trim())
      : [];
  } catch {
    return [];
  }
}

/** Top-right gamepad icon: green = live input, amber = paired/asleep, red = none. */
function setPadBadge(
  state: "ok" | "missing" | "busy" | "idle" | "wake",
  pads?: { name: string; detail: string }[],
  extraTitle?: string,
) {
  const el = document.getElementById("pad-badge") as HTMLButtonElement | null;
  if (!el) return;
  el.className = `pad-badge${state === "idle" ? "" : ` ${state}`}`;
  // Never disable the control — disabled + long IPC feels like a beachball on macOS.
  // Clicks are ignored via padDetectInFlight instead.
  el.disabled = false;
  el.setAttribute("aria-busy", state === "busy" ? "true" : "false");
  const tip = el.querySelector(".pad-badge-tip");
  if (state === "ok" && pads?.length) {
    const names = pads.map((p) => p.name).join(", ");
    el.title = `Gamepad live: ${names} — click to re-check`;
    el.setAttribute("aria-label", `Gamepad live: ${names}`);
    if (tip) tip.textContent = names;
    stopPadLiveWatch();
  } else if (state === "wake") {
    el.title =
      extraTitle ||
      "Yellow = paired on TV, but not live yet. Press Home/A on the pad (pairing is fine). Ring turns green when the HID link is up.";
    el.setAttribute(
      "aria-label",
      "Gamepad paired but asleep — press a button to wake",
    );
    if (tip) tip.textContent = "Paired · press button";
    startPadLiveWatch();
  } else if (state === "missing") {
    const last = lastKnownPadNames();
    if (last.length) {
      const who = last.join(", ");
      el.title =
        extraTitle ||
        `No live gamepad (last seen: ${who}). Bond stays on the TV — click to reconnect, or re-pair only if TV Bluetooth list is empty.`;
      el.setAttribute("aria-label", `Reconnect gamepad (last seen ${who})`);
      if (tip) tip.textContent = "Reconnect";
      startPadLiveWatch();
    } else {
      el.title = extraTitle || "Pair Gamepad";
      el.setAttribute("aria-label", "Pair Gamepad");
      if (tip) tip.textContent = "Pair Gamepad";
      stopPadLiveWatch();
    }
  } else if (state === "busy") {
    el.title =
      extraTitle ||
      "Reconnecting gamepad… press any button on the pad to wake it";
    el.setAttribute("aria-label", "Reconnecting gamepad");
    if (tip) tip.textContent = "Connecting…";
  } else {
    el.title = "Pair Gamepad";
    el.setAttribute("aria-label", "Pair Gamepad");
    if (tip) tip.textContent = "Pair Gamepad";
  }
}

/** While yellow/red with a known pad: poll for live input so the ring goes green without another click. */
let padLiveWatchTimer: ReturnType<typeof setInterval> | null = null;
let padLiveWatchUntil = 0;

function stopPadLiveWatch() {
  if (padLiveWatchTimer != null) {
    clearInterval(padLiveWatchTimer);
    padLiveWatchTimer = null;
  }
  padLiveWatchUntil = 0;
}

function startPadLiveWatch() {
  // Refresh window of background polls after each wake/missing state
  padLiveWatchUntil = Date.now() + 120_000; // 2 minutes
  if (padLiveWatchTimer != null) return;
  padLiveWatchTimer = setInterval(() => {
    void pollPadLiveQuiet();
  }, 2500);
}

/** Quiet list-gamepads only — flips yellow → green when the pad wakes. */
async function pollPadLiveQuiet() {
  if (padDetectInFlight) return;
  if (!padLiveWatchUntil || Date.now() > padLiveWatchUntil) {
    stopPadLiveWatch();
    return;
  }
  const el = document.getElementById("pad-badge");
  if (!el) return;
  // Stop if already green
  if (el.classList.contains("ok")) {
    stopPadLiveWatch();
    return;
  }
  // Only auto-promote from wake/missing
  if (!el.classList.contains("wake") && !el.classList.contains("missing")) {
    return;
  }
  try {
    const settings = readForm();
    const padsOut = await invoke<string>("ra_list_gamepads", { settings });
    const { pads } = parseGamepadList(padsOut || "");
    if (pads.length) {
      rememberLivePads(pads);
      setPadBadge("ok", pads);
      log(
        `Gamepad live: ${pads.map((p) => p.name).join(", ")} (auto-detected after wake)`,
      );
      stopPadLiveWatch();
    }
  } catch {
    /* ignore probe errors during watch */
  }
}

/** Short sleep that keeps the UI event loop free. */
function sleepUi(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Prevent stacked SSH detects (double-click / badge + Settings). */
let padDetectInFlight = false;

/** Parse reconnect-gamepad machine lines into user-facing notes. */
function parseReconnectLines(raw: string): {
  pads: { name: string; detail: string }[];
  msgs: string[];
  ok: boolean;
  /** Paired BT pad found even if input not up yet */
  paired: boolean;
  pairedNames: string[];
  connecting: boolean;
  hint: string | null;
} {
  const { pads, none, hint } = parseGamepadList(raw || "");
  const msgs: string[] = [];
  const pairedNames: string[] = [];
  let ok = pads.length > 0;
  let paired = false;
  let connecting = false;
  for (const line of (raw || "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("bt|")) {
      paired = true;
      const p = t.slice(3).split("|");
      const n = p[0] || "?";
      pairedNames.push(n);
      msgs.push(`Paired on TV: ${n} (${p[1] || "?"})`);
    } else if (t.startsWith("stale|")) {
      const p = t.slice(6).split("|");
      const n = Number(p[0] || 0);
      if (n > 0) msgs.push(`Cleared ${n} stale input node(s) on TV`);
    } else if (t.startsWith("reconnect|")) {
      const p = t.slice("reconnect|".length).split("|");
      const status = (p[1] || "").toLowerCase();
      const msg = p.slice(2).join("|") || status;
      if (status === "ok") {
        ok = true;
        msgs.push(msg);
      } else if (status === "fail") {
        msgs.push(msg);
      } else if (status === "try" || status === "wait") {
        if (/connect|press|wake|button|paging/i.test(msg)) connecting = true;
        msgs.push(msg);
      }
    }
  }
  if (!ok && none) msgs.push(none);
  return { pads, msgs, ok, paired, pairedNames, connecting, hint };
}

/**
 * Lightweight TV gamepad probe for the top-right badge.
 * User click or app-start autoReconnect: if missing, kicks Bluetooth HID
 * reconnect (quick), then polls with short list-gamepads calls.
 *
 * Note: the Bluetooth *bond* lives on the TV (Settings → Bluetooth). Restarting
 * this Mac app never unpairs it — only the active HID link / input node drops
 * when the pad sleeps. We re-issue hid/connect to restore that link.
 */
async function detectPadBadge(opts?: {
  fromUser?: boolean;
  quiet?: boolean;
  /** Skip BT reconnect even for user clicks (background poll). */
  noReconnect?: boolean;
  /**
   * App-start / background restore: same HID reconnect as a user click,
   * without treating it as a manual Detect (quieter log defaults).
   */
  autoReconnect?: boolean;
}): Promise<{ name: string; detail: string }[] | null> {
  if (padDetectInFlight) return null;
  padDetectInFlight = true;
  const fromUser = opts?.fromUser === true;
  const quiet = opts?.quiet === true;
  const autoReconnect = opts?.autoReconnect === true;
  const tryReconnect =
    (fromUser || autoReconnect) && opts?.noReconnect !== true;
  const lastKnown = lastKnownPadNames();
  // Immediate blue — never leave a stale red during the click
  setPadBadge(
    "busy",
    undefined,
    tryReconnect
      ? lastKnown.length
        ? `Restoring ${lastKnown.join(", ")}… PRESS ANY BUTTON on the pad`
        : "Reconnecting… PRESS ANY BUTTON on the gamepad to wake it"
      : "Checking gamepad on TV…",
  );
  await yieldToUi();
  try {
    const settings = readForm();

    // Fast list first (one short SSH)
    let padsOut = await invoke<string>("ra_list_gamepads", { settings });
    await yieldToUi();
    let { pads, none, hint } = parseGamepadList(padsOut || "");
    let pairedWake = false;
    let pairedNames: string[] = [];

    // No live input node → kick hid/connect (bond should still be on TV)
    if (!pads.length && tryReconnect) {
      if (!quiet) {
        log(
          "No gamepad input on TV — restoring Bluetooth HID link (pairing stays on TV).\n" +
            "→ PRESS ANY BUTTON on the GameSir now (Home / A / stick)…",
        );
      } else if (autoReconnect) {
        log(
          lastKnown.length
            ? `Restoring last gamepad (${lastKnown.join(", ")}) in background… press a button if it stays asleep.`
            : "Restoring Bluetooth gamepad link in background…",
        );
      }
      setPadBadge(
        "busy",
        undefined,
        "Connecting… press any button on the gamepad NOW",
      );
      await yieldToUi();
      try {
        const reconOut = await invoke<string>("ra_reconnect_gamepad", {
          settings,
        });
        await yieldToUi();
        const recon = parseReconnectLines(reconOut || "");
        pairedWake = recon.paired || recon.connecting;
        pairedNames = recon.pairedNames;
        if (!quiet) {
          for (const m of recon.msgs) log(m, !recon.ok && !recon.paired);
          if (recon.hint) log(recon.hint, true);
        } else if (autoReconnect && recon.pairedNames.length) {
          log(
            `TV still has paired pad: ${recon.pairedNames.join(", ")} — reconnecting HID…`,
          );
        }
        if (recon.pads.length) {
          rememberLivePads(recon.pads);
          setPadBadge("ok", recon.pads);
          if (!quiet || autoReconnect) {
            log(
              `Gamepad restored:\n` +
                recon.pads
                  .map(
                    (p) =>
                      `  • ${p.name}${p.detail ? ` (${p.detail})` : ""}`,
                  )
                  .join("\n"),
            );
          }
          return recon.pads;
        }
      } catch (e) {
        if (!quiet) log(formatError(e), true);
      }

      // Poll with short list-gamepads only — never stack full reconnect mid-wait
      // (extra reconnect SSH was a common beachball source while the badge pulsed).
      // Longer window when TV reports a paired bond (yellow → green after button press).
      const pollMs = 650;
      const pollCount =
        autoReconnect && quiet
          ? pairedWake || pairedNames.length
            ? 14 // ~9s when we know a bond exists
            : 8
          : pairedWake || pairedNames.length
            ? 16 // ~10s user click with paired pad
            : 12;
      for (let i = 0; i < pollCount; i++) {
        setPadBadge(
          "busy",
          undefined,
          `Waiting for pad… press a button (${i + 1}/${pollCount})`,
        );
        await sleepUi(pollMs);
        await yieldToUi();
        try {
          padsOut = await invoke<string>("ra_list_gamepads", { settings });
          ({ pads, none, hint } = parseGamepadList(padsOut || ""));
          if (pads.length) {
            rememberLivePads(pads);
            setPadBadge("ok", pads);
            if (!quiet || autoReconnect) {
              log(
                `Gamepad restored:\n` +
                  pads
                    .map(
                      (p) =>
                        `  • ${p.name}${p.detail ? ` (${p.detail})` : ""}`,
                    )
                    .join("\n"),
              );
            }
            return pads;
          }
        } catch {
          /* keep polling */
        }
        // Light re-kick a few times while waiting for the user to press a button
        if (i === 3 || i === 8 || i === 12) {
          try {
            await invoke<string>("ra_reconnect_gamepad", { settings });
            await yieldToUi();
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (pads.length) {
      rememberLivePads(pads);
      setPadBadge("ok", pads);
      if (fromUser && !quiet) {
        log(
          `Gamepad(s) on TV (${pads.length}):\n` +
            pads
              .map((p) => `  • ${p.name}${p.detail ? ` (${p.detail})` : ""}`)
              .join("\n"),
        );
      } else if (autoReconnect && quiet) {
        log(
          `Gamepad already live: ${pads.map((p) => p.name).join(", ")}`,
        );
      }
      return pads;
    }

    // Paired but not live → amber “wake” ring (not red). Bond is still on TV.
    // Yellow ≠ failed pair — it means “bonded, waiting for live HID / button press”.
    if (pairedWake || pairedNames.length) {
      const who = pairedNames.join(", ") || "gamepad";
      setPadBadge(
        "wake",
        undefined,
        `${who}: paired on TV (yellow). Press Home/A now — ring turns green when live. No re-pair needed.`,
      );
      if (!quiet || autoReconnect) {
        log(
          `Paired pad (${who}) is on the TV Bluetooth list but not live yet.\n` +
            "  · Yellow ring = pairing OK, HID asleep\n" +
            "  · Press Home / A / any button — badge turns green automatically\n" +
            "  · Do not re-pair unless the TV no longer lists the pad",
          true,
        );
      }
      return [];
    }

    // Fall back to last-known name so red badge doesn't look like a wipe
    if (lastKnown.length) {
      setPadBadge(
        "wake",
        undefined,
        `${lastKnown.join(", ")}: not live (yellow). Press a button or click the icon — bond usually still on TV.`,
      );
      if (!quiet || autoReconnect) {
        log(
          `No live pad input. Last seen: ${lastKnown.join(", ")}.\n` +
            "  · Yellow = we still expect this pad (not a failed pair)\n" +
            "  · Press a button on the pad; the ring turns green when the TV sees it\n" +
            "  · Only re-pair if TV Bluetooth no longer shows the controller",
          true,
        );
      }
      return [];
    }

    setPadBadge("missing");
    if (fromUser && !quiet) {
      log(
        none ||
          "No gamepad on TV. Pair once in TV Bluetooth, wake the pad, click the gamepad icon again.",
        true,
      );
      if (hint) log(hint, true);
    }
    return [];
  } catch (e) {
    setPadBadge("missing");
    if (fromUser && !quiet) {
      log(formatError(e), true);
    }
    return null;
  } finally {
    padDetectInFlight = false;
  }
}

async function refreshPadMouseStatus(opts?: {
  fromDetect?: boolean;
  /** Badge-only: skip mapper status SSH (faster, no beachball). */
  badgeOnly?: boolean;
}) {
  const fromDetect = opts?.fromDetect === true;
  const badgeOnly = opts?.badgeOnly === true;

  if (badgeOnly) {
    await detectPadBadge({ fromUser: fromDetect, quiet: !fromDetect });
    return;
  }

  const detectBtn = document.getElementById(
    "btn-detect-gamepad",
  ) as HTMLButtonElement | null;
  if (fromDetect) {
    setPadMapStatus("busy", "Detecting gamepads on TV…");
    setPadBadge("busy");
    if (detectBtn) {
      detectBtn.disabled = true;
      detectBtn.dataset.prevLabel = detectBtn.textContent || "Detect gamepad";
      detectBtn.textContent = "Detecting…";
    }
    log("Detect gamepad: scanning TV input devices…");
    await yieldToUi();
  }

  // If a badge probe is already running, wait a tick then continue
  // (avoid launching a third concurrent SSH storm).
  if (padDetectInFlight) {
    await yieldToUi();
  }

  try {
    const settings = readForm();
    // Badge first (quick), then mapper status — sequential to avoid double-SSH races
    let padsOut = await invoke<string>("ra_list_gamepads", { settings });
    let { pads, none, hint } = parseGamepadList(padsOut || "");

    // Settings Detect: if no input node, try Bluetooth HID reconnect
    if (!pads.length && fromDetect) {
      log(
        "No pad input — trying Bluetooth reconnect (press a button on the pad)…",
      );
      setPadMapStatus("busy", "Reconnecting Bluetooth gamepad…");
      await yieldToUi();
      try {
        const reconOut = await invoke<string>("ra_reconnect_gamepad", {
          settings,
        });
        const recon = parseReconnectLines(reconOut || "");
        for (const m of recon.msgs) log(m, !recon.ok);
        if (recon.hint) log(recon.hint, true);
        if (recon.pads.length) {
          pads = recon.pads;
          none = null;
          hint = null;
        } else {
          padsOut = await invoke<string>("ra_list_gamepads", { settings });
          ({ pads, none, hint } = parseGamepadList(padsOut || ""));
        }
      } catch (e) {
        log(formatError(e), true);
      }
    }

    if (pads.length) {
      setPadBadge("ok", pads);
      if (fromDetect) {
        log(
          `Gamepad(s) on TV (${pads.length}):\n` +
            pads
              .map((p) => `  • ${p.name}${p.detail ? ` (${p.detail})` : ""}`)
              .join("\n"),
        );
        const gamesir = pads.find((p) => isGameSirPadName(p.name));
        if (gamesir) {
          log(
            `GameSir identified: ${gamesir.name}` +
              (gameir.detail ? ` (${gamesir.detail})` : "") +
              " — PS4-mode pads report as “Wireless Controller” (Sony 054c:09cc); that is expected.",
          );
        } else {
          log(
            "No GameSir-like pad (name or Wireless Controller HID). Pair GameSir on TV Bluetooth, wake it, Detect again.",
            true,
          );
        }
      }
    } else {
      setPadBadge("missing");
      if (fromDetect) {
        log(
          none ||
            "No gamepad detected on the TV. Pair it in TV Bluetooth settings, wake it, then Detect again.",
          true,
        );
        if (hint) log(hint, true);
      }
    }

    // Mapper status is optional for header detect; only needed in Settings
    let t = "";
    try {
      const statusOut = await invoke<string>("ra_pad_mouse_status", {
        settings,
      });
      t = (statusOut || "").trim();
    } catch {
      t = "";
    }

    if (/^running/i.test(t)) {
      const mBtn = t.match(/button=(\S+)/i);
      if (mBtn && PAD_MOUSE_BUTTONS.some((b) => b.id === mBtn[1])) {
        padMouseBtn = mBtn[1];
      }
      const mAct = t.match(/action=(\S+)/i);
      if (mAct && isPadMapAction(mAct[1])) {
        padMapAction = mAct[1];
      }
      updatePadMapUi();
      const padNote = pads.length
        ? ` · pad: ${pads[0].name}`
        : " · ⚠ no pad device seen (pair Bluetooth on TV)";
      setPadMapStatus("ok", `✓ ${t}${padNote}`);
    } else if (pads.length) {
      setPadMapStatus(
        "ok",
        `✓ Detected: ${pads.map((p) => p.name).join(", ")} — click Apply to map`,
      );
    } else {
      setPadMapStatus(
        "err",
        `${t || "Mapper off"} · ${none || "No gamepad on TV — pair Bluetooth, wake pad, Detect again"}`,
      );
    }
  } catch (e) {
    const err = formatError(e);
    if (fromDetect) log(err, true);
    setPadBadge("missing");
    setPadMapStatus(
      "err",
      `Detect failed — ${summarizeError(err, 90)}`,
    );
    // Don't thrash the connection badge for a gamepad probe failure
  } finally {
    if (fromDetect && detectBtn) {
      detectBtn.disabled = false;
      detectBtn.textContent = detectBtn.dataset.prevLabel || "Detect gamepad";
      delete detectBtn.dataset.prevLabel;
    }
  }
}

function setControllerStatus(
  state: "ok" | "err" | "busy" | "idle",
  message: string,
) {
  const el = document.getElementById("controller-status");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message;
  el.className = `kickstart-status field-status${
    state === "ok" ? " ok" : state === "err" ? " err" : state === "busy" ? " busy" : ""
  }`;
}

/** Parse setup-controller machine output into a short success summary. */
function parseControllerSetupOut(out: string): {
  ok: boolean;
  profiles: string | null;
  joy: string | null;
  auto: string | null;
  joypadIndex: string | null;
} {
  const text = out || "";
  // Shell prints CFG_OK after writing retroarch.cfg; also accept profile counts
  const ok =
    /\bCFG_OK\b/i.test(text) ||
    /\bsdl2_profiles=\d+/i.test(text) ||
    /Controller setup done/i.test(text) ||
    /PROFILES_AFTER=\d+/i.test(text);
  const profiles =
    text.match(/sdl2_profiles=(\d+)/i)?.[1] ||
    text.match(/PROFILES_AFTER=(\d+)/i)?.[1] ||
    null;
  // Prefer value after = "…"; tolerate doubled "key=key = value" summary lines
  const joy =
    text.match(/input_joypad_driver\s*=\s*"?(sdl2|udev|linuxraw|xinput)["\s]/i)?.[1] ||
    text.match(/input_joypad_driver=.*?"(sdl2)"/i)?.[1] ||
    null;
  const auto =
    text.match(/input_autodetect_enable\s*=\s*"?(true|false|1|0)"?/i)?.[1] ||
    null;
  const joypadIndex =
    text.match(/joypad_index=(\d+)/i)?.[1] || null;
  return { ok, profiles, joy, auto, joypadIndex };
}

/**
 * Auto-configure RetroArch on the TV for Bluetooth/USB pads:
 * sdl2 drivers, autoconfig on, download joypad profiles.
 * (Interactive Bind All cannot be automated — profiles replace it.)
 */
async function setupController(opts?: {
  refresh?: boolean;
  quiet?: boolean;
  busy?: boolean;
}): Promise<boolean> {
  const refresh = opts?.refresh === true;
  const quiet = opts?.quiet === true;
  // Never use app-wide setBusy for this (can take minutes if downloading profiles)
  const btnId = refresh ? "btn-setup-controller-refresh" : "btn-setup-controller";
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  const prev = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = refresh ? "Refreshing…" : "Configuring…";
  }
  if (!quiet) {
    log(
      refresh
        ? "Re-downloading controller profiles and applying gamepad settings on TV…"
        : "Auto-configuring RetroArch controller support on TV…",
    );
  }
  setControllerStatus(
    "busy",
    refresh ? "Refreshing controller profiles…" : "Configuring controller support…",
  );
  await yieldToUi();
  try {
    const settings = readForm();
    const out = await invoke<string>("ra_setup_controller", {
      settings,
      refresh,
    });
    let parsed = parseControllerSetupOut(out || "");
    // Treat structured success as OK even if the invoke wrapper was odd
    if (!parsed.ok && (out || "").trim()) {
      // Still got output without markers — not a hard fail if no "error:"
      if (!/error:|failed|timed out/i.test(out || "")) {
        parsed = { ...parsed, ok: true };
      }
    }
    if (!parsed.ok) {
      throw new Error(
        (out || "").trim() ||
          "Controller setup returned no success markers (CFG_OK / profiles).",
      );
    }

    // Do not force network badge here on quiet boot (other tasks own it)
    if (!quiet) {
      setConnBadge("ok", `${settings.user}@${settings.host}`);
    }
    // Full remote dump only when the user clicked Configure (not every boot)
    if (!quiet && out?.trim()) log(out.trimEnd());

    const okBits = [
      parsed.joy ? `joypad=${parsed.joy}` : null,
      parsed.auto ? `autoconfig=${parsed.auto}` : null,
      parsed.profiles != null ? `${parsed.profiles} profiles` : null,
      parsed.joypadIndex != null ? `pad js${parsed.joypadIndex}` : null,
    ].filter(Boolean);
    setControllerStatus(
      "ok",
      `✓ Controller setup applied${okBits.length ? ` (${okBits.join(", ")})` : ""}. Restart RetroArch if it was open.`,
    );
    if (!quiet) {
      log(
        `✓ Controller setup OK${okBits.length ? ` — ${okBits.join(", ")}` : ""}. ` +
          "Pair/wake the Bluetooth pad, then Restart RetroArch if a game was already running.",
      );
    } else {
      log(
        `✓ Controller setup OK${okBits.length ? ` (${okBits.join(", ")})` : ""}`,
      );
    }
    try {
      localStorage.setItem("ra-controller-setup-done", "1");
    } catch {
      /* ignore */
    }
    return true;
  } catch (e) {
    const err = formatError(e);
    // Quiet boot: never paint the network badge red or leave a sticky red wall of text
    if (quiet) {
      log(`Controller setup skipped/failed (non-fatal): ${summarizeError(err, 100)}`, true);
      setControllerStatus(
        "idle",
        "Controller setup not confirmed — open Settings → Controller and click Configure if pads misbehave.",
      );
    } else {
      log(err, true);
      setConnBadge("err", summarizeError(err), err);
      setControllerStatus("err", summarizeError(err, 120));
      log(
        "Controller setup failed. Check SSH (Test SSH), then try Configure again. " +
          "This is separate from game Fire/Start.",
        true,
      );
    }
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}

type TvMediaItem = {
  system: string;
  idx: string;
  name: string;
  path: string;
  /** True when in-app Play can launch it (play / play-media). */
  playable: boolean;
};

/** Systems with a play-media path in control-retroarch.sh. */
const PLAYABLE_MEDIA_SYSTEMS = new Set([
  "amiga",
  "snes",
  "nes",
  "genesis",
  "gba",
  "gb",
  "gbc",
  "n64",
  "psx",
]);

/** Whether this app can launch the file with Play (needs matching engine on TV). */
function isMediaPlayable(system: string, name: string): boolean {
  const sys = system.trim().toLowerCase();
  if (!PLAYABLE_MEDIA_SYSTEMS.has(sys)) return false;
  const n = name.toLowerCase();
  switch (sys) {
    case "amiga":
      return /\.(adf|adz|dms|ipf|hdf|hdz|lha)$/i.test(n);
    case "snes":
      return /\.(sfc|smc|fig|swc|zip|7z)$/i.test(n);
    case "nes":
      return /\.(nes|fds|unf|unif|zip|7z)$/i.test(n);
    case "genesis":
      return /\.(md|gen|smd|32x|sms|gg|bin|zip|7z)$/i.test(n);
    case "gba":
      return /\.(gba|zip|7z)$/i.test(n);
    case "gb":
    case "gbc":
      return /\.(gb|gbc|sgb|zip|7z)$/i.test(n);
    case "n64":
      return /\.(n64|z64|v64|zip|7z)$/i.test(n);
    case "psx":
      return /\.(pbp|cue|chd|iso|img|mdf|toc|m3u|bin|zip|7z)$/i.test(n);
    default:
      return false;
  }
}

/** Parse media-machine lines: system|idx|name|path (and legacy adfs idx|name|path). */
function parseMediaLines(text: string): TvMediaItem[] {
  const items: TvMediaItem[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("==>") || line.startsWith("warn:") || line.startsWith("#"))
      continue;
    if (!line.includes("|")) continue;
    const parts = line.split("|");
    // media-machine: system|idx|name|path
    if (parts.length >= 4 && !/^\d+$/.test(parts[0].trim())) {
      const system = parts[0].trim().toLowerCase();
      const idx = parts[1].trim();
      const name = parts[2].trim();
      const path = parts.slice(3).join("|").trim();
      const key = `${system}/${name}`.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      items.push({
        system,
        idx,
        name,
        path,
        playable: isMediaPlayable(system, name),
      });
      continue;
    }
    // Legacy adfs-machine: idx|name|path
    if (parts.length >= 2 && /^\d+$/.test(parts[0].trim())) {
      const idx = parts[0].trim();
      const name = parts[1].trim();
      const path = parts.slice(2).join("|").trim();
      const key = `amiga/${name}`.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      items.push({
        system: "amiga",
        idx,
        name,
        path,
        playable: isMediaPlayable("amiga", name),
      });
    }
  }
  return items;
}

function mediaSystemLabel(sys: string): string {
  switch (sys) {
    case "amiga":
      return "Amiga";
    case "snes":
      return "SNES";
    case "nes":
      return "NES";
    case "genesis":
      return "Genesis";
    case "gba":
      return "GBA";
    case "gb":
    case "gbc":
      return "GB/C";
    case "n64":
      return "N64";
    case "psx":
      return "PS1";
    default:
      return sys.toUpperCase() || "Media";
  }
}

function mediaSystemLogoId(sys: string): string {
  if (sys === "gbc") return "gbc";
  if (sys === "gb") return "gbc";
  if (ENGINE_LOGOS[sys]) return sys;
  return "other";
}

/** Last successfully launched Amiga media (by name). */
let playingAdfName: string | null = null;

function setPlayingAdf(name: string | null) {
  playingAdfName = name;
  document.querySelectorAll<HTMLButtonElement>("#adf-list button.play").forEach((btn) => {
    const match = !!name && btn.dataset.adfName === name;
    btn.classList.toggle("playing", match);
    btn.textContent = match ? "Playing" : "Play";
    btn.setAttribute("aria-pressed", match ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>("#adf-list .list-item").forEach((row) => {
    const match = !!name && row.dataset.adfName === name;
    row.classList.toggle("is-playing", match);
    const star = row.querySelector<HTMLElement>(".adf-star");
    if (star) {
      star.hidden = !match;
      star.textContent = match ? "*" : "";
    }
  });
}

async function reloadAdfs(opts?: { busy?: boolean; quiet?: boolean }) {
  const box = $("adf-list");
  box.innerHTML = `<div class="empty">Loading games, demos &amp; media from TV…</div>`;
  await yieldToUi();

  // Prefer full multi-system list; fall back to Amiga-only if older script
  let out: string | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const settings = readForm();
      out = await invoke<string>("ra_list_media", { settings });
      if (out != null) break;
    } catch (e) {
      lastErr = formatError(e);
      // Older control script without media-machine → Amiga ADFs only
      if (/unknown|media-machine|not found|usage/i.test(lastErr)) {
        try {
          out = await invoke<string>("ra_list_adfs", { settings: readForm() });
          break;
        } catch (e2) {
          lastErr = formatError(e2);
        }
      }
      if (attempt === 1) {
        await sleepUi(400);
        continue;
      }
    }
  }

  if (out == null) {
    const short = summarizeError(lastErr || "SSH failed", 100);
    box.innerHTML = `<div class="empty err-empty">Could not list media on TV<br/><span class="err-detail">${escapeHtml(short)}</span><br/><span class="muted">Check Settings → Connection, then Reload.</span></div>`;
    if (!opts?.quiet) log(`Media list failed: ${lastErr || short}`, true);
    // Always paint red on total media-list failure (boot used to leave idle/green)
    setConnBadge("err", short, lastErr || short);
    return;
  }

  try {
    const s = readForm();
    setConnBadge("ok", `${s.user}@${s.host}`);
  } catch {
    /* ignore */
  }

  const items = parseMediaLines(out);
  if (!items.length) {
    box.innerHTML = `<div class="empty">No games, demos, or media on the TV yet.<br/><span class="muted">Install from Archive.org below, or Upload Amiga… from this Mac.</span></div>`;
    if (!opts?.quiet) log("No media files under disks/ on the TV.");
    return;
  }

  const bySys = new Map<string, TvMediaItem[]>();
  for (const it of items) {
    const list = bySys.get(it.system) || [];
    list.push(it);
    bySys.set(it.system, list);
  }
  const order = ["amiga", "snes", "nes", "genesis", "gba", "gb", "gbc", "n64", "psx"];
  const systems = [
    ...order.filter((s) => bySys.has(s)),
    ...[...bySys.keys()].filter((s) => !order.includes(s)).sort(),
  ];

  const counts = systems
    .map((s) => `${mediaSystemLabel(s)} ${bySys.get(s)!.length}`)
    .join(", ");
  if (!opts?.quiet) {
    log(`Media on TV: ${items.length} file${items.length === 1 ? "" : "s"} (${counts}).`);
  }

  box.innerHTML = "";
  let globalIdx = 0;
  for (const sys of systems) {
    const list = bySys.get(sys)!;
    const head = document.createElement("div");
    head.className = "media-section-head";
    head.innerHTML = `<span class="media-section-logo">${engineLogoHtml(mediaSystemLogoId(sys))}</span><span class="media-section-title"></span><span class="media-section-count"></span>`;
    (head.querySelector(".media-section-title") as HTMLElement).textContent =
      mediaSystemLabel(sys);
    (head.querySelector(".media-section-count") as HTMLElement).textContent =
      `${list.length}`;
    box.appendChild(head);

    for (const it of list) {
      globalIdx += 1;
      const row = document.createElement("div");
      row.className = "list-item media-row";
      row.dataset.adfName = it.name;
      row.dataset.system = it.system;
      row.innerHTML = `<div class="list-item-meta"><span class="idx">${globalIdx}.</span><span class="content-core media-sys-chip" title="System"></span><span class="adf-star" hidden aria-label="Now playing"></span><span class="name"></span></div>`;
      (row.querySelector(".content-core") as HTMLElement).textContent =
        mediaSystemLabel(it.system);
      (row.querySelector(".name") as HTMLElement).textContent = it.name;
      (row.querySelector(".name") as HTMLElement).title = it.path || it.name;

      const actions = document.createElement("div");
      actions.className = "list-item-actions";

      if (it.playable) {
        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "play";
        playBtn.dataset.adfName = it.name;
        playBtn.dataset.adfIdx = it.idx;
        playBtn.dataset.system = it.system;
        playBtn.textContent = "Play";
        playBtn.setAttribute("aria-pressed", "false");
        const sysLabel = mediaSystemLabel(it.system);
        playBtn.title =
          it.system === "amiga"
            ? "Launch with Amiga engine (PUAE)"
            : `Launch with ${sysLabel} engine on the TV`;
        playBtn.addEventListener("click", async () => {
          if (playBtn.dataset.launching === "1") return;
          playBtn.dataset.launching = "1";
          playBtn.disabled = true;
          const prevLabel = playBtn.textContent || "Play";
          playBtn.textContent = "Starting…";
          log(`Playing ${sysLabel} #${it.idx} ${it.name}…`);
          setPlayingAdf(it.name);
          await yieldToUi();
          try {
            let r: string | null = null;
            if (it.system === "amiga") {
              r = await run<string>(
                "ra_play",
                { pick: it.idx },
                { busy: false },
              );
            } else {
              r = await run<string>(
                "ra_play_media",
                { system: it.system, pick: it.idx },
                { busy: false },
              );
            }
            if (r != null) {
              log(r.trimEnd());
              setPlayingAdf(it.name);
              if (it.system === "amiga") {
                log(
                  "Amiga title screen: press gamepad B (Fire) to start — mouse click usually does nothing.\n" +
                    "  · Wake pad via top-right gamepad icon if needed\n" +
                    "  · Or use While playing → Fire / Start\n" +
                    "  · X = Space · L2/R2 = mouse buttons · right stick = mouse",
                );
              } else {
                log(
                  `${sysLabel} should be loading on the TV. Use your gamepad; wake it via the top-right icon if needed.`,
                );
              }
            } else if (playingAdfName === it.name) {
              setPlayingAdf(null);
            }
          } finally {
            delete playBtn.dataset.launching;
            playBtn.disabled = false;
            if (playingAdfName === it.name) setPlayingAdf(it.name);
            else playBtn.textContent = prevLabel;
          }
        });
        actions.appendChild(playBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "remove";
        removeBtn.textContent = "Remove";
        removeBtn.title = `Delete ${it.name} from the TV (disks/${it.system})`;
        removeBtn.addEventListener("click", async () => {
          const ok = window.confirm(
            `Remove "${it.name}" from the TV?\n\nThis deletes the file under disks/${it.system} and cannot be undone.`,
          );
          if (!ok) return;
          log(`Removing ${sysLabel} #${it.idx} ${it.name}…`);
          removeBtn.disabled = true;
          removeBtn.textContent = "…";
          await yieldToUi();
          try {
            let r: string | null = null;
            if (it.system === "amiga") {
              r = await run<string>("ra_remove", { pick: it.idx });
            } else {
              r = await run<string>("ra_remove_media", {
                system: it.system,
                pick: it.idx,
              });
            }
            if (r != null) {
              log(r.trimEnd());
              if (playingAdfName === it.name) playingAdfName = null;
              await reloadAdfs();
            } else {
              removeBtn.disabled = false;
              removeBtn.textContent = "Remove";
            }
          } catch {
            removeBtn.disabled = false;
            removeBtn.textContent = "Remove";
          }
        });
        actions.appendChild(removeBtn);
      } else {
        const note = document.createElement("span");
        note.className = "media-play-note";
        note.textContent = "On TV";
        note.title =
          "Installed on the TV. In-app Play is not available for this file type — open it from RetroArch, or install a matching engine in Settings → engines.";
        actions.appendChild(note);
      }

      row.appendChild(actions);
      box.appendChild(row);
    }
  }
  setPlayingAdf(playingAdfName);
}

async function reloadCores(opts?: { busy?: boolean; quiet?: boolean }) {
  const el = $("core-list");
  el.innerHTML = `<div class="empty">Loading engines…</div>`;
  await yieldToUi();

  // Retry once — boot can race other SSH (ControlMaster / busy TV)
  let out: string | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const settings = readForm();
      out = await invoke<string>("ra_list_cores_machine", { settings });
      if (out != null) break;
    } catch (e) {
      lastErr = formatError(e);
      if (attempt === 1) {
        await sleepUi(450);
        continue;
      }
    }
  }

  if (out == null) {
    const short = summarizeError(lastErr || "SSH / cores-machine failed", 100);
    el.innerHTML = `<div class="empty err-empty">Could not list engines<br/><span class="err-detail">${escapeHtml(short)}</span><br/><span class="muted">Check Settings → Connection (Test SSH), then Reload.</span></div>`;
    if (!opts?.quiet) {
      log(`Engines on TV failed: ${lastErr || short}`, true);
    }
    // Network/SSH failure → red. Script parse glitches that aren't networkish leave badge alone.
    if (!lastErr || isNetworkishError(lastErr)) {
      setConnBadge("err", short, lastErr || short);
    }
    return;
  }

  // Success path: keep conn badge green if we got data from the TV
  try {
    const s = readForm();
    setConnBadge("ok", `${s.user}@${s.host}`);
  } catch {
    /* ignore */
  }

  const installed = parseInstalledCoresMachine(out);
  if (!installed.length) {
    // Raw non-empty but unparsed — show a hint instead of a blank “none”
    const rawBits = (out || "").trim();
    if (rawBits && !/\|/.test(rawBits)) {
      el.innerHTML = `<div class="empty err-empty">Unexpected engines response<br/><span class="muted">See activity log · click Reload</span></div>`;
      if (!opts?.quiet) log(`cores-machine raw (unparsed):\n${rawBits.slice(0, 500)}`, true);
      return;
    }
    el.innerHTML = `<div class="empty">No engines installed on the TV yet.<br/><span class="muted">Open Settings → Amiga &amp; engines to install PUAE, SNES, etc.</span></div>`;
    if (!opts?.quiet) log("No engines (cores) installed on TV.");
    return;
  }
  const amiga = installed.filter((c) => isAmigaCore(c.file, c.label));
  const other = installed.filter((c) => !isAmigaCore(c.file, c.label));
  el.innerHTML = "";
  el.classList.add("engine-grid", "engine-grid-installed");

  const renderGroup = (
    title: string,
    items: InstalledCore[],
    kind: "amiga" | "other",
  ) => {
    if (!items.length) return;
    const head = document.createElement("div");
    head.className = `engine-section-head core-section-head core-section-${kind}`;
    const logoId = kind === "amiga" ? "amiga" : "other";
    head.innerHTML = `<span class="engine-section-logo">${engineLogoHtml(logoId)}</span><span class="engine-section-title"></span>`;
    (head.querySelector(".engine-section-title") as HTMLElement).textContent =
      kind === "amiga"
        ? `${title} · powers Play ADF`
        : `${title} · RetroArch on TV`;
    el.appendChild(head);
    for (const c of items) {
      const fam = engineFamilyFor(c.file, c.label);
      const sysId = fam?.id || (kind === "amiga" ? "amiga" : "other");
      const card = document.createElement("article");
      card.className = `engine-card engine-card-installed engine-card-${kind}`;
      card.style.setProperty("--engine-accent", fam?.accent || "#64748b");
      card.innerHTML = `
        <div class="engine-card-logo">${engineLogoHtml(sysId)}</div>
        <div class="engine-card-body">
          <div class="engine-card-kicker"></div>
          <h4 class="engine-card-title"></h4>
          <p class="engine-card-file"></p>
          <div class="engine-card-badges">
            <span class="core-sys-badge core-sys-${kind}"></span>
            <span class="engine-on-tv-badge">On TV</span>
          </div>
        </div>`;
      (card.querySelector(".engine-card-kicker") as HTMLElement).textContent =
        fam?.engineLabel || (kind === "amiga" ? "Amiga engine" : "Engine");
      (card.querySelector(".engine-card-title") as HTMLElement).textContent =
        engineDisplayName(c.file, c.label);
      (card.querySelector(".engine-card-file") as HTMLElement).textContent = c.file;
      (card.querySelector(".core-sys-badge") as HTMLElement).textContent =
        fam?.short || (kind === "amiga" ? "Amiga" : coreFamilyTitle(c.file, c.label));
      el.appendChild(card);
    }
  };

  renderGroup("Amiga engines", amiga, "amiga");
  renderGroup("Other engines", other, "other");
  log(
    `Engines on TV: ${amiga.length} Amiga, ${other.length} other system${
      other.length === 1 ? "" : "s"
    }.`,
  );
}

/** Native file picker → scp selected .adf files to the TV disks directory. */
async function pickAndUploadAdfs() {
  const selected = await open({
    multiple: true,
    directory: false,
    title: "Select Amiga disk image(s) (.adf)",
    filters: [{ name: "Amiga disk", extensions: ["adf", "ADF"] }],
  });
  if (selected == null) return;

  const paths = Array.isArray(selected) ? selected : [selected];
  const adfs = paths.filter((p) => /\.adf$/i.test(p));
  if (!adfs.length) {
    log("No .adf files selected.", true);
    return;
  }
  if (adfs.length !== paths.length) {
    log(`Skipping ${paths.length - adfs.length} non-.adf file(s).`);
  }

  log(`Uploading ${adfs.length} .adf file(s) to TV…`);
  const btn = document.getElementById("btn-adf-add") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevLabel = btn.textContent || "Upload from Mac…";
    btn.textContent = "Uploading…";
  }
  await yieldToUi();
  try {
    const r = await run<string>("ra_upload_adfs", { paths: adfs });
    if (r != null) {
      log(r.trimEnd());
      await reloadAdfs();
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevLabel || "Upload from Mac…";
      delete btn.dataset.prevLabel;
    }
  }
}

async function browseKey() {
  // Prefer starting in ~/.ssh when possible
  let defaultPath: string | undefined;
  try {
    const candidates = await invoke<string[]>("default_ssh_key_candidates");
    if (candidates[0]) {
      // directory containing default key
      defaultPath = candidates[0].replace(/\/[^/]+$/, "");
    }
  } catch {
    /* ignore */
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Select SSH private key",
    defaultPath,
  });
  if (typeof selected === "string") {
    $input("sshKey").value = selected;
    await refreshPathStatus();
  }
}

async function revealKeyInFinder() {
  const key = $input("sshKey").value.trim();
  if (!key) {
    log("Set an SSH key path first.", true);
    return;
  }
  try {
    const resolved = await invoke<string>("resolve_path", { path: key });
    const exists = await invoke<boolean>("path_exists", { path: key });
    if (exists) {
      await revealItemInDir(resolved);
      log(`Revealed key in Finder:\n${resolved}`);
    } else {
      // Reveal parent folder if key missing
      const parent = resolved.replace(/\/[^/]+$/, "") || resolved;
      await revealItemInDir(parent);
      log(
        `Key file not found. Opened parent folder:\n${parent}\nExpected file:\n${resolved}`,
        true,
      );
    }
  } catch (e) {
    log(String(e), true);
  }
}

async function useDefaultKey() {
  try {
    const candidates = await invoke<string[]>("default_ssh_key_candidates");
    // Prefer first existing candidate, else first path
    let chosen = candidates[0] || "";
    for (const c of candidates) {
      if (await invoke<boolean>("path_exists", { path: c })) {
        chosen = c;
        break;
      }
    }
    if (chosen) {
      $input("sshKey").value = chosen;
      await refreshPathStatus();
      log(`SSH key set to:\n${chosen}`);
    }
  } catch (e) {
    log(String(e), true);
  }
}

async function browseScript() {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Select control-retroarch.sh",
    filters: [{ name: "Shell", extensions: ["sh"] }],
  });
  if (typeof selected === "string") {
    $input("scriptPath").value = selected;
    await refreshPathStatus();
  }
}

const THEME_KEY = "ra-theme";
const THEMES = ["midnight", "light", "tokyo-night"] as const;
type ThemeId = (typeof THEMES)[number];

function isThemeId(v: string | null | undefined): v is ThemeId {
  return v === "midnight" || v === "light" || v === "tokyo-night";
}

function syncThemeButtons(theme: ThemeId) {
  document.querySelectorAll<HTMLButtonElement>(".theme-btn[data-theme]").forEach((b) => {
    const on = b.dataset.theme === theme;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  syncThemeButtons(theme);
}

function initTheme() {
  let theme: ThemeId = "midnight";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (isThemeId(saved)) theme = saved;
  } catch {
    /* ignore */
  }
  applyTheme(theme);
  document.querySelectorAll<HTMLButtonElement>(".theme-btn[data-theme]").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.theme;
      if (isThemeId(v)) applyTheme(v);
    });
  });
  // Sync if another window (mouse) or tab changes theme
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY && e.newValue && isThemeId(e.newValue)) {
      document.documentElement.setAttribute("data-theme", e.newValue);
      syncThemeButtons(e.newValue);
    }
  });
}

/** Dock shell: document never scrolls; only #app does. */
function lockAppShell() {
  const freeze = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("height", "100%", "important");
    el.style.setProperty("max-height", "100%", "important");
  };
  freeze(document.documentElement);
  freeze(document.body);
  document.body.style.setProperty("display", "flex", "important");
  document.body.style.setProperty("flex-direction", "column", "important");
  // Kill any accidental window/document scroll (WKWebView sometimes does this)
  const pin = () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement.scrollTop !== 0) {
      document.documentElement.scrollTop = 0;
    }
    if (document.body.scrollTop !== 0) {
      document.body.scrollTop = 0;
    }
  };
  pin();
  window.addEventListener("scroll", pin, { passive: true, capture: true });
  document.addEventListener("scroll", pin, { passive: true, capture: true });
}

window.addEventListener("DOMContentLoaded", async () => {
  lockAppShell();
  initTheme();
  // Wire Fix network before any await so the button always works
  wireFixNetworkButtons();
  wireScreensaverSetting();
  initSettingsNav();
  await initSettings();

  $("btn-settings").addEventListener("click", () => {
    const panel = $("settings-panel");
    const openNow = panel.hasAttribute("hidden");
    showSettings(openNow);
  });
  $("btn-settings-close").addEventListener("click", () => showSettings(false));
  $("btn-settings-cancel")?.addEventListener("click", () => showSettings(false));

  // Close only on a true backdrop click (press + release both on the dimmed area).
  // Selecting/scrolling long path fields often ends with mouseup on the overlay —
  // that must NOT close Settings.
  const settingsPanel = $("settings-panel");
  let backdropPointerDown = false;
  settingsPanel.addEventListener("pointerdown", (e) => {
    backdropPointerDown = e.target === settingsPanel;
  });
  settingsPanel.addEventListener("pointerup", (e) => {
    if (backdropPointerDown && e.target === settingsPanel) {
      showSettings(false);
    }
    backdropPointerDown = false;
  });
  settingsPanel.addEventListener("pointercancel", () => {
    backdropPointerDown = false;
  });
  // Keep interactions inside the dialog from bubbling to the overlay
  settingsPanel
    .querySelector(".settings-modal")
    ?.addEventListener("pointerdown", (e) => e.stopPropagation());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !settingsPanel.hasAttribute("hidden")) {
      showSettings(false);
    }
  });

  $("btn-save").addEventListener("click", () => void saveSettings());
  $("btn-test-ssh").addEventListener("click", () => void testSsh());
  $("btn-reset-defaults").addEventListener("click", async () => {
    const def = await invoke<Settings>("default_settings");
    writeForm(def);
    log("Form reset to defaults (not saved yet).");
  });
  $("btn-amiga-defaults").addEventListener("click", () => {
    applyAmigaPathDefaults();
  });

  // Core select + install / catalog / Kickstart
  const coreSelect = document.getElementById("core-select") as HTMLSelectElement | null;
  coreSelect?.addEventListener("change", () => {
    if (!coreSelect.value) return;
    $input("corePath").value = coreSelect.value;
    log(`Core selected: ${basenameCore(coreSelect.value)}`);
  });
  $input("corePath").addEventListener("change", () => syncCoreSelectFromPath());
  $("btn-cores-refresh-settings").addEventListener("click", () => {
    void refreshCoreSelect();
  });
  $("btn-install-selected-core").addEventListener("click", () => {
    const sel = document.getElementById("core-select") as HTMLSelectElement | null;
    const file =
      sel?.selectedOptions[0]?.dataset.file ||
      basenameCore($input("corePath").value);
    void installCoreByName(file);
  });
  // Engine catalog: console-logo chips (Amiga, NES, SNES, …)
  renderEngineScopeChips(document.getElementById("engine-scope-bar"));
  $("btn-cores-list-all").addEventListener("click", () => {
    void listAllAvailableCores();
  });
  $input("core-filter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void listAllAvailableCores();
    }
  });
  renderKickstartPicker();
  $("btn-install-kickstart").addEventListener("click", () => {
    void installKickstartFromUrl();
  });
  $("btn-kickstart-select-rec")?.addEventListener("click", () => {
    setKickstartSelection("recommended");
    log("Selected recommended Kickstarts (1.3 A500, 2.04 A500, 3.1 A1200).");
  });
  $("btn-kickstart-select-none")?.addEventListener("click", () => {
    setKickstartSelection("none");
  });
  $input("kickstart-url")?.addEventListener("input", () => {
    updateKickstartInstallButton();
  });
  $("btn-kickstart-refresh")?.addEventListener("click", () => {
    void refreshKickstartStatus({ busy: false, quiet: false });
  });

  $("btn-browse-key").addEventListener("click", () => void browseKey());
  $("btn-reveal-key").addEventListener("click", () => void revealKeyInFinder());
  $("btn-use-default-key").addEventListener("click", () => void useDefaultKey());
  $("btn-browse-script").addEventListener("click", () => void browseScript());

  // Show default path label
  void (async () => {
    try {
      const candidates = await invoke<string[]>("default_ssh_key_candidates");
      const el = $("sshKey-default");
      if (candidates[0]) el.textContent = candidates[0];
    } catch {
      /* keep placeholder */
    }
  })();

  $input("sshKey").addEventListener("input", () => void refreshPathStatus());
  $input("sshKey").addEventListener("change", () => void refreshPathStatus());
  $input("scriptPath").addEventListener("change", () => void refreshPathStatus());
  $input("host").addEventListener("change", () => {
    const s = readForm();
    if (!lastConnError) setConnBadge("idle", `${s.user}@${s.host}`);
  });

  $("btn-adfs").addEventListener("click", () => void reloadAdfs());
  $("btn-adf-add").addEventListener("click", () => void pickAndUploadAdfs());
  $("btn-cores").addEventListener("click", () => void reloadCores());
  $("btn-setup-controller")?.addEventListener("click", () => {
    void setupController({ refresh: false, busy: false });
  });
  $("btn-setup-controller-refresh")?.addEventListener("click", () => {
    void setupController({ refresh: true, busy: false });
  });

  initPadMapUi();
  $("pad-map-action")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (isPadMapAction(v)) setPadMapAction(v);
  });
  $("btn-pad-mouse-apply")?.addEventListener("click", () => {
    void applyPadMouseMapping();
  });
  $("btn-pad-mouse-stop")?.addEventListener("click", () => {
    void stopPadMouseMapping();
  });
  $("btn-detect-gamepad")?.addEventListener("click", () => {
    void refreshPadMouseStatus({ fromDetect: true });
  });
  // Header icon: detect, and if missing try Bluetooth HID reconnect
  $("pad-badge")?.addEventListener("click", () => {
    void detectPadBadge({ fromUser: true });
  });
  $("btn-open-pad-map-settings")?.addEventListener("click", () => {
    if (hasAcceptedDisclaimer()) {
      showSettings(true, { section: "controller" });
    } else openSettingsAfterDisclaimer = true;
  });

  // Archive.org catalog browser — chips match Settings core families
  renderCatalogSystemChips();
  updateCatalogSystemUi();
  $("btn-catalog-sites").addEventListener("click", () => void loadCatalogSites());
  $("btn-catalog-add-site").addEventListener("click", () => void addCustomCatalogSite());
  $input("catalog-site-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addCustomCatalogSite();
    }
  });
  document.querySelectorAll<HTMLButtonElement>(".cat-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cat = (chip.dataset.cat || "all") as typeof catalogCategory;
      catalogCategory = cat;
      document.querySelectorAll(".cat-chip").forEach((c) => {
        const on = c === chip;
        c.classList.toggle("active", on);
        c.setAttribute("aria-selected", on ? "true" : "false");
      });
      applyCategoryFilter();
      // Re-run active search under the new category
      if (catalogMode === "search" && catalogSearch) {
        catalogOffset = 0;
        void runCatalogSearch();
      }
    });
  });
  $("btn-catalog-refresh").addEventListener("click", () => {
    if (catalogMode === "search" && catalogSearch) {
      void runCatalogSearch({ refresh: true });
      return;
    }
    if (!catalogSiteId) {
      void loadCatalogSites();
      return;
    }
    void loadCatalogAdfs({ refresh: true });
  });
  $("btn-catalog-search").addEventListener("click", () => {
    catalogOffset = 0;
    void runCatalogSearch();
  });
  $input("catalog-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      catalogOffset = 0;
      void runCatalogSearch();
    }
  });
  $("btn-catalog-prev").addEventListener("click", () => catalogPagePrev());
  $("btn-catalog-next").addEventListener("click", () => catalogPageNext());
  $("btn-catalog-prev-foot")?.addEventListener("click", () => catalogPagePrev());
  $("btn-catalog-next-foot")?.addEventListener("click", () => catalogPageNext());
  $("btn-catalog-install").addEventListener("click", () => {
    void installCatalogAdfs(selectedCatalogIds());
  });
  $("btn-clear").addEventListener("click", () => {
    $("log").textContent = "";
  });
  /** Inject Amiga / TV mouse button: left | right | middle */
  async function amigaMouseClick(button: "left" | "right" | "middle") {
    const labels = { left: "LMB", right: "RMB", middle: "MMB" } as const;
    const label = labels[button];
    const note =
      button === "middle"
        ? " (emulator extra — classic Amiga mice only have L+R)"
        : "";
    log(`Mouse ${label} → TV${note}…`);
    await yieldToUi();
    try {
      const settings = readForm();
      const cmd =
        button === "left"
          ? "ra_click_left"
          : button === "right"
            ? "ra_click_right"
            : "ra_click_middle";
      const out = await invoke<string>(cmd, { settings, times: 1 });
      if (out?.trim()) log(out.trimEnd());
      else log(`✓ ${label} sent`);
    } catch (e) {
      log(formatError(e), true);
    }
  }

  $("btn-amiga-lmb")?.addEventListener("click", () => {
    void amigaMouseClick("left");
  });
  $("btn-amiga-rmb")?.addEventListener("click", () => {
    void amigaMouseClick("right");
  });
  $("btn-amiga-mmb")?.addEventListener("click", () => {
    void amigaMouseClick("middle");
  });

  /**
   * Title-screen helper — injects real Fire on the TV gamepad event node
   * plus Space/Enter/LMB. Logs the full firing string for the activity log.
   */
  $("btn-amiga-fire")?.addEventListener("click", async () => {
    const btn = $("btn-amiga-fire") as HTMLButtonElement;
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const prev = btn.querySelector(".playing-tool-name")?.textContent || "Fire / Start";
    const nameEl = btn.querySelector(".playing-tool-name");
    if (nameEl) nameEl.textContent = "Firing…";
    log("Fire / Start → TV / RetroArch…");
    await yieldToUi();
    try {
      const settings = readForm();
      const out = await invoke<string>("ra_amiga_fire", { settings });
      const lines = (out || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const fireLines: string[] = [];
      let fireString: string | null = null;
      let okLine: string | null = null;
      let hint: string | null = null;
      for (const t of lines) {
        if (t.startsWith("#")) continue;
        if (t.startsWith("fire|string|")) {
          fireString = t.slice("fire|string|".length);
        } else if (t.startsWith("fire|")) {
          // fire|pad|…  fire|key|…  fire|mouse|…  fire|begin|…
          const rest = t.slice("fire|".length);
          const pipe = rest.indexOf("|");
          const kind = pipe >= 0 ? rest.slice(0, pipe) : rest;
          const detail = pipe >= 0 ? rest.slice(pipe + 1) : "";
          if (kind === "begin") fireLines.push(detail);
          else fireLines.push(`  · ${kind}: ${detail}`);
        } else if (t.startsWith("ok|")) {
          okLine = t.slice(3);
        } else if (t.startsWith("hint|")) {
          hint = t.slice(5);
        }
      }
      if (fireLines.length) {
        log(fireLines.join("\n"));
      }
      if (fireString) {
        log(`→ firing string: ${fireString}`);
      } else if (out?.trim() && !fireLines.length) {
        // Fallback: raw machine output
        log(out.trimEnd());
      }
      if (okLine) log(`✓ ${okLine}`);
      if (hint) log(hint, true);
      else {
        log(
          "Still stuck? 1) Wake pad (top-right) 2) Play ADF again 3) Press B on pad.",
        );
      }
    } catch (e) {
      log(formatError(e), true);
    } finally {
      delete btn.dataset.busy;
      if (nameEl) nameEl.textContent = prev;
    }
  });
  $("btn-mouse-window").addEventListener("click", async () => {
    try {
      // ensure latest SSH settings are saved for the control window
      await invoke("save_settings", { settings: readForm() });
      await invoke("open_mouse_window");
      log("Opened mouse + keyboard control window.");
    } catch (e) {
      log(String(e), true);
    }
  });
  $("btn-remote-window").addEventListener("click", async () => {
    try {
      await invoke("save_settings", { settings: readForm() });
      await invoke("open_remote_window");
      log("Opened TV volume window.");
    } catch (e) {
      log(String(e), true);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.busy === "1") return;
      const act = btn.dataset.act!;
      // Quit = full stop (same as restart's stop half: graceful close, then force-kill).
      // One button covers both "quit cleanly" and "it's stuck" cases.
      if (act === "quit" || act === "close") {
        log("quit…");
        btn.dataset.busy = "1";
        btn.disabled = true;
        await yieldToUi();
        try {
          const closed = await run<string>("ra_close", undefined, {
            busy: false,
          });
          const killed = await run<string>("ra_kill", undefined, {
            busy: false,
          });
          if (closed == null && killed == null) {
            log("Quit failed — check connection / Settings.", true);
          } else {
            setPlayingAdf(null);
            log("RetroArch stopped.");
          }
        } finally {
          delete btn.dataset.busy;
          btn.disabled = false;
        }
        return;
      }
      const map: Record<string, string> = {
        launch: "ra_launch",
        restart: "ra_restart",
      };
      const cmd = map[act];
      if (!cmd) return;
      const prev = btn.textContent || act;
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.textContent =
        act === "restart" ? "Restarting…" : act === "launch" ? "Opening…" : "…";
      log(
        act === "restart"
          ? "Restarting RetroArch (main menu)…"
          : act === "launch"
            ? "Opening RetroArch main menu…"
            : `${act}…`,
      );
      await yieldToUi();
      try {
        // Never freeze the whole app for SSH/luna (same fix as Play)
        const r = await run<string>(cmd, undefined, { busy: false });
        if (r != null) log(r.trimEnd());
        if (act === "restart" || act === "launch") {
          setPlayingAdf(null);
        }
      } finally {
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.textContent = prev;
      }
    });
  });

  // Game source link cards
  renderGameSources();

  // First-run disclaimer (blocks until accepted; may already be visible via inline script)
  const disclaimerOverlay = document.getElementById("disclaimer-overlay");
  const acceptBtn = document.getElementById("btn-disclaimer-accept");
  acceptBtn?.addEventListener("click", () => acceptDisclaimer());
  // Do not dismiss by clicking backdrop or Escape — must accept explicitly
  disclaimerOverlay
    ?.querySelector(".disclaimer-modal")
    ?.addEventListener("pointerdown", (e) => e.stopPropagation());

  if (!hasAcceptedDisclaimer()) {
    showDisclaimer(true);
    log("Please accept the disclaimer to continue.");
  } else {
    showDisclaimer(false);
  }

  // Open settings first if key/script missing
  const s = readForm();
  setConnBadge("idle", `${s.user}@${s.host}`);
  const keyOk = s.sshKey
    ? await invoke<boolean>("path_exists", { path: s.sshKey })
    : false;
  if (!keyOk) {
    // Defer settings until disclaimer is accepted so disclaimer stays on top
    if (hasAcceptedDisclaimer()) showSettings(true);
    else openSettingsAfterDisclaimer = true;
    const hint = s.sshKey
      ? `SSH key not found: ${s.sshKey}`
      : "SSH key not set — open Settings";
    log("Configure SSH host and private key in Settings, then Test SSH.");
    setConnBadge("err", summarizeError(hint, 48), hint);
    // Sites list does not need SSH
    void loadCatalogSites();
  } else {
    // Background refresh — never block window open / main thread beachball
    log("Connecting to TV in background…");
    $("adf-list").innerHTML = `<div class="empty">Loading ADFs from TV…</div>`;
    $("core-list").innerHTML = `<div class="empty">Loading engines…</div>`;
    $("catalog-sites").innerHTML = `<div class="empty">Loading sites…</div>`;
    void (async () => {
      // Parallel boot loads — controller setup runs AFTER so it does not fight
      // ControlMaster SSH with ADF/core/status and leave a sticky red failure.
      await Promise.all([
        status(),
        reloadAdfs({ busy: false }),
        reloadCores({ busy: false }),
        loadCatalogSites(),
        setDefaultTvVolume(),
      ]);
      // Authoritative badge: local catalog/list-sites must not leave a false green
      // when the TV is actually unreachable.
      await refreshNetworkBadgeFromProbe({ quiet: true });
      // Idempotent; quiet = no network-badge thrash (probe above owns the icon)
      await setupController({ refresh: false, quiet: true, busy: false });
      // Optional: keep TV screensaver off while this Mac app is open
      if (isDisableScreensaverOpt()) {
        void applyScreensaverDisable({ quiet: true });
      }
      // Restore gamepad HID link if the pad is paired but asleep (bond stays on TV).
      // Background only — never blocks window open.
      void (async () => {
        await detectPadBadge({ quiet: true, autoReconnect: true });
        if (isPadMouseEnabled()) {
          // Full status only when we need to re-apply the mapper
          void refreshPadMouseStatus();
          void applyPadMouseMapping();
        }
      })();
    })();
  }
});
