import { invoke } from "@tauri-apps/api/core";
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

/** Soft busy flag — does not freeze the whole window (no beachball). */
let busyCount = 0;
function setBusy(busy: boolean) {
  if (busy) busyCount += 1;
  else busyCount = Math.max(0, busyCount - 1);
  const on = busyCount > 0;
  document.body.classList.toggle("is-busy", on);
  // Only disable primary action buttons, keep Settings / Clear usable
  document
    .querySelectorAll<HTMLButtonElement>(
      "[data-act], .play, .remove, .install, #btn-status, #btn-adfs, #btn-adf-add, #btn-cores, #btn-test-ssh, #btn-save, #btn-catalog-sites, #btn-catalog-add-site, #btn-catalog-refresh, #btn-catalog-search, #btn-catalog-prev, #btn-catalog-next, #btn-catalog-install, #btn-cores-refresh-settings, #btn-install-selected-core, #btn-cores-list-all, #btn-install-kickstart, #btn-kickstart-example",
    )
    .forEach((b) => {
      b.disabled = on;
    });
  // Keep catalog toolbar state consistent when not busy
  if (!on) {
    syncCatalogToolbar();
  }
}

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
};

const CATALOG_PAGE = 40;
const DEFAULT_TV_VOLUME = 4;
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
} {
  let total = 0;
  let siteLabel = "";
  const items: CatalogAdf[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const m = t.match(/site=(\S+)\s+total=(\d+)/);
      if (m) {
        siteLabel = m[1] === "search" ? "Search results" : m[1];
        total = Number(m[2]) || 0;
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
  return { items, total, siteLabel };
}

function syncCatalogToolbar() {
  const btnPrev = document.getElementById("btn-catalog-prev") as HTMLButtonElement | null;
  const btnNext = document.getElementById("btn-catalog-next") as HTMLButtonElement | null;
  const btnInst = document.getElementById("btn-catalog-install") as HTMLButtonElement | null;
  if (!btnPrev || !btnNext || !btnInst) return;
  const hasResults = catalogItems.length > 0 || catalogTotal > 0;
  const canPage = catalogMode === "search" || !!catalogSiteId;
  btnPrev.disabled = !canPage || catalogOffset <= 0;
  btnNext.disabled = !canPage || catalogOffset + CATALOG_PAGE >= catalogTotal;
  const selected = document.querySelectorAll<HTMLInputElement>(
    "#catalog-adfs input[type=checkbox]:checked",
  ).length;
  btnInst.disabled = !hasResults || selected === 0;
}

function applyCategoryFilter() {
  if (catalogCategory === "all") {
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
    hint.textContent =
      catalogCategory === "all" ? "" : `(${catalogCategory})`;
  }
  renderCatalogSites();
}

async function loadCatalogSites() {
  const box = $("catalog-sites");
  box.innerHTML = `<div class="empty">Loading sites…</div>`;
  // Load all categories; filter client-side for chips
  const out = await run<string>(
    "amiga_list_sites",
    { category: null },
    { busy: true },
  );
  if (out == null) {
    box.innerHTML = `<div class="empty">Failed to load sites — is setup-amiga.sh next to control-retroarch.sh?</div>`;
    return;
  }
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
  setBusy(true);
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
    setBusy(false);
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

async function selectCatalogSite(id: string) {
  catalogSiteId = id;
  catalogMode = "site";
  catalogOffset = 0;
  catalogSearch = $input("catalog-search").value.trim();
  document.querySelectorAll(".site-item").forEach((el) => {
    el.classList.toggle(
      "selected",
      (el as HTMLElement).dataset.siteId === id,
    );
  });
  await loadCatalogAdfs();
}

function renderCatalogResults(
  parsed: { items: CatalogAdf[]; total: number; siteLabel: string },
  emptyHint: string,
) {
  const box = $("catalog-adfs");
  catalogItems = parsed.items;
  catalogTotal = parsed.total;
  const page = Math.floor(catalogOffset / CATALOG_PAGE) + 1;
  const pages = Math.max(1, Math.ceil(catalogTotal / CATALOG_PAGE) || 1);
  const cat =
    catalogCategory === "all" ? "" : ` · ${catalogCategory}`;
  $("catalog-meta").textContent = parsed.siteLabel
    ? `${parsed.siteLabel}${cat} · ${catalogTotal} titles · page ${page}/${pages}`
    : `${catalogTotal} titles · page ${page}/${pages}`;

  if (!catalogItems.length) {
    box.innerHTML = `<div class="empty">${emptyHint}</div>`;
    syncCatalogToolbar();
    return;
  }

  box.innerHTML = "";
  for (const it of catalogItems) {
    const row = document.createElement("div");
    row.className = "list-item catalog-adf-item";
    const lab = document.createElement("label");
    lab.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(it.idx);
    cb.addEventListener("change", () => syncCatalogToolbar());
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.siteLabel
      ? `${it.title}  ·  ${it.siteLabel}`
      : it.title;
    lab.appendChild(cb);
    lab.appendChild(name);
    const size = document.createElement("span");
    size.className = "adf-size";
    size.textContent = humanSize(it.size);
    const inst = document.createElement("button");
    inst.type = "button";
    inst.className = "install";
    inst.textContent = "Install";
    inst.title = `Download and install “${it.title}” to the TV`;
    inst.addEventListener("click", () => void installCatalogAdfs([it.idx]));
    row.appendChild(lab);
    row.appendChild(size);
    row.appendChild(inst);
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
  const out = await run<string>(
    "amiga_list_adfs",
    {
      site: catalogSiteId,
      search: catalogSearch || null,
      limit: CATALOG_PAGE,
      offset: catalogOffset,
      refresh: opts?.refresh ?? false,
    },
    { busy: true },
  );
  if (out == null) {
    box.innerHTML = `<div class="empty">Failed to load catalog.</div>`;
    $("catalog-meta").textContent = "";
    syncCatalogToolbar();
    return;
  }
  renderCatalogResults(
    parseCatalogAdfs(out),
    `No titles match${catalogSearch ? ` “${catalogSearch}”` : ""}.`,
  );
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
    log("Enter a search term for games, demos, or utilities.", true);
    return;
  }
  catalogMode = "search";
  catalogSiteId = null;
  document.querySelectorAll(".site-item").forEach((el) => {
    el.classList.remove("selected");
  });
  const box = $("catalog-adfs");
  box.innerHTML = `<div class="empty">Searching Archive.org catalogs…</div>`;
  $("catalog-meta").textContent = "Searching…";
  const out = await run<string>(
    "amiga_search_adfs",
    {
      search: catalogSearch,
      category: catalogCategory === "all" ? null : catalogCategory,
      limit: CATALOG_PAGE,
      offset: catalogOffset,
      refresh: opts?.refresh ?? false,
    },
    { busy: true },
  );
  if (out == null) {
    box.innerHTML = `<div class="empty">Search failed.</div>`;
    $("catalog-meta").textContent = "";
    syncCatalogToolbar();
    return;
  }
  renderCatalogResults(
    parseCatalogAdfs(out),
    `No matches for “${catalogSearch}” in ${catalogCategory === "all" ? "all categories" : catalogCategory}.`,
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

async function installCatalogAdfs(ids: number[]) {
  if (!ids.length) return;
  const picks = ids
    .map((idx) => catalogItems.find((i) => i.idx === idx))
    .filter((x): x is CatalogAdf => !!x);
  if (!picks.length) {
    log("No matching catalog rows for the selection.", true);
    return;
  }

  const withUrl = picks.filter((p) => !!p.url?.trim());
  if (!withUrl.length) {
    log("Selected items have no download URL — reload the catalog and try again.", true);
    return;
  }
  if (withUrl.length !== picks.length) {
    log(`Warning: ${picks.length - withUrl.length} item(s) missing URL, skipped.`);
  }

  const ok = window.confirm(
    `Install ${withUrl.length} disk image(s) to the TV?\n\n` +
      withUrl
        .slice(0, 8)
        .map((p) => `• ${p.title}`)
        .join("\n") +
      (withUrl.length > 8 ? `\n… and ${withUrl.length - 8} more` : "") +
      `\n\nDownloaded from Archive.org and uploaded over SSH.\nOnly install titles you are entitled to use.`,
  );
  if (!ok) return;

  log(`Installing ${withUrl.length} ADF(s) via direct download…`);
  for (const it of withUrl) {
    log(`  → ${it.title}`);
  }

  // Install by URL (not re-search). Old path used --search on filenames with
  // $ [] () which broke grep and always forced ids:[1].
  const r = await run<string>("amiga_install_urls", {
    items: withUrl.map((it) => ({
      url: it.url,
      file: it.file || "",
      title: it.title || "",
    })),
  });
  if (r != null) {
    log(r.trimEnd());
    log(`Install finished — reloading disks on TV…`);
  } else {
    log("Install failed — see error above.", true);
  }
  await reloadAdfs({ busy: false });
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

/** Well-known Amiga (and starter) cores — always offered even if not installed yet */
const KNOWN_CORES: { file: string; label: string }[] = [
  { file: "puae2021_libretro.so", label: "Commodore Amiga (PUAE 2021)" },
  { file: "puae_libretro.so", label: "Commodore Amiga (PUAE)" },
  { file: "amiberry_libretro.so", label: "Commodore Amiga (Amiberry)" },
  { file: "snes9x2010_libretro.so", label: "Super Nintendo (snes9x2010)" },
  { file: "gpsp_libretro.so", label: "Game Boy Advance (gpSP)" },
  { file: "gambatte_libretro.so", label: "Game Boy / Color (gambatte)" },
];

const EXAMPLE_KICKSTART_URL =
  "https://raw.githubusercontent.com/Abdess/retrobios/main/bios/Commodore/Amiga/kick34005.A500";

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
    if (!t || t.startsWith("#") || t.startsWith("(")) continue;
    const parts = t.split("|");
    if (parts.length < 4) continue;
    const [id, file, label, path] = parts;
    if (!file?.endsWith(".so")) continue;
    out.push({ id, file, label, path });
  }
  return out;
}

/** Populate the Settings core dropdown from TV + known cores. */
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
      busy: opts?.busy !== false,
    });
    if (raw) installed = parseInstalledCoresMachine(raw);
  } catch {
    /* offline / SSH fail — still show known cores */
  }

  sel.innerHTML = "";
  const installedFiles = new Set(installed.map((c) => c.file));

  if (installed.length) {
    const og = document.createElement("optgroup");
    og.label = "Installed on TV";
    for (const c of installed) {
      const opt = document.createElement("option");
      opt.value = c.path;
      opt.dataset.file = c.file;
      opt.textContent = `${c.label} — ${c.file}`;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }

  const ogKnown = document.createElement("optgroup");
  ogKnown.label = installed.length ? "Known (may need install)" : "Known cores";
  for (const k of KNOWN_CORES) {
    if (installedFiles.has(k.file)) continue;
    const opt = document.createElement("option");
    opt.value = corePathForFile(k.file);
    opt.dataset.file = k.file;
    opt.textContent = `${k.label} — ${k.file}`;
    ogKnown.appendChild(opt);
  }
  if (ogKnown.childElementCount) sel.appendChild(ogKnown);

  if (!sel.options.length) {
    const opt = document.createElement("option");
    opt.value = corePathForFile("puae2021_libretro.so");
    opt.dataset.file = "puae2021_libretro.so";
    opt.textContent = "Commodore Amiga (PUAE 2021)";
    sel.appendChild(opt);
  }

  // Restore selection
  if (currentPath) {
    $input("corePath").value = currentPath;
    syncCoreSelectFromPath();
  } else if (sel.options[0]) {
    sel.selectedIndex = 0;
    $input("corePath").value = sel.value;
  }
}

async function installCoreByName(file: string) {
  const name = file.trim();
  if (!name) {
    log("No core selected.", true);
    return;
  }
  log(`Installing core ${name} on TV…`);
  const r = await run<string>("ra_install_core", { name });
  if (r == null) return;
  log(r.trimEnd());
  // Point settings at the new core
  $input("corePath").value = corePathForFile(
    name.endsWith(".so") ? name : `${name.replace(/\.zip$/, "")}`,
  );
  // normalize
  let fileName = basenameCore($input("corePath").value);
  if (!fileName.endsWith(".so")) {
    if (fileName.endsWith("_libretro")) fileName = `${fileName}.so`;
    else if (!fileName.includes("_libretro")) fileName = `${fileName}_libretro.so`;
    $input("corePath").value = corePathForFile(fileName);
  }
  await refreshCoreSelect({ busy: false });
  await reloadCores({ busy: false });
  log(`Active core path set to ${$input("corePath").value} (Save settings to keep).`);
}

async function listAllAvailableCores() {
  const box = $("core-available-list");
  const filter = $input("core-filter").value.trim();
  box.innerHTML = `<div class="empty muted">Loading core catalog…</div>`;
  const raw = await run<string>(
    "ra_list_available_cores",
    filter ? { filter } : {},
  );
  if (raw == null) {
    box.innerHTML = `<div class="empty">Failed to load catalog — check network / SSH</div>`;
    return;
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|") && !l.startsWith("==>"));
  if (!lines.length) {
    box.innerHTML = `<div class="empty muted">No cores match${filter ? ` “${escapeHtml(filter)}”` : ""}.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const line of lines) {
    const pipe = line.indexOf("|");
    const file = line.slice(0, pipe);
    const label = line.slice(pipe + 1);
    if (!file.endsWith(".so")) continue;
    const row = document.createElement("div");
    row.className = "core-row";
    row.setAttribute("role", "listitem");
    row.innerHTML = `<div class="core-meta"><span class="core-label"></span><span class="core-file"></span></div>`;
    (row.querySelector(".core-label") as HTMLElement).textContent = label;
    (row.querySelector(".core-file") as HTMLElement).textContent = file;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Install";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await installCoreByName(file);
        btn.textContent = "Done";
      } catch {
        btn.textContent = "Retry";
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  log(`Listed ${box.querySelectorAll(".core-row").length} downloadable cores.`);
}

async function installKickstartFromUrl() {
  const url = $input("kickstart-url").value.trim();
  if (!url) {
    log("Enter a Kickstart URL first.", true);
    return;
  }
  log(`Installing Kickstart from URL…\n  ${url}`);
  const r = await run<string>("amiga_install_kickstart", { urls: [url] });
  if (r == null) return;
  log(r.trimEnd());
  log("Kickstart install finished — files go to the system directory on the TV.");
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showSettings(openPanel: boolean) {
  const panel = $("settings-panel");
  const btn = $("btn-settings");
  if (openPanel) {
    panel.removeAttribute("hidden");
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
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
  setBusy(true);
  try {
    const msg = await invoke<string>("save_settings", { settings: s });
    log(msg);
    $("conn-badge").textContent = `${s.user}@${s.host}`;
    $("conn-badge").className = "conn-badge ok";
    await refreshPathStatus();
    showSettings(false);
  } catch (e) {
    log(String(e), true);
  } finally {
    setBusy(false);
  }
}

async function testSsh() {
  const statusEl = $("ssh-test-status");
  const btn = $("btn-test-ssh") as HTMLButtonElement;
  statusEl.textContent = "Testing SSH…";
  statusEl.className = "field-status";
  btn.classList.remove("ssh-ok", "ssh-err");
  log("Testing SSH…");
  setBusy(true);
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
    $("conn-badge").textContent = `${s.user}@${s.host} · SSH ok`;
    $("conn-badge").className = "conn-badge ok";
  } catch (e) {
    const err = String(e);
    statusEl.textContent = "✗ SSH test failed — check host, user, and key";
    statusEl.className = "field-status err";
    btn.classList.add("ssh-err");
    log(err, true);
    $("conn-badge").textContent = "SSH failed";
    $("conn-badge").className = "conn-badge err";
  } finally {
    setBusy(false);
  }
}

async function run<T>(
  name: string,
  args?: Record<string, unknown>,
  opts?: { quiet?: boolean; busy?: boolean },
): Promise<T | null> {
  const useBusy = opts?.busy !== false;
  if (useBusy) setBusy(true);
  const badge = $("conn-badge");
  try {
    const settings = readForm();
    const result = await invoke<T>(name, { settings, ...args });
    badge.textContent = `${settings.user}@${settings.host}`;
    badge.className = "conn-badge ok";
    return result;
  } catch (e) {
    const msg = String(e);
    if (!opts?.quiet) log(msg, true);
    $("conn-badge").textContent = "error";
    $("conn-badge").className = "conn-badge err";
    return null;
  } finally {
    if (useBusy) setBusy(false);
  }
}

async function status() {
  const out = await run<string>("ra_status");
  if (out != null) log(out.trimEnd());
}

function parseAdfLines(text: string): { idx: string; name: string }[] {
  const items: { idx: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\)\s+(.+\.adf)\s*$/i);
    if (m) items.push({ idx: m[1], name: m[2].trim() });
  }
  return items;
}

/** Last successfully launched ADF (by name — index can shift after remove). */
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

async function reloadAdfs(opts?: { busy?: boolean }) {
  const box = $("adf-list");
  box.innerHTML = `<div class="empty">Loading ADFs from TV…</div>`;
  const out = await run<string>("ra_list_adfs", undefined, {
    busy: opts?.busy !== false,
  });
  if (out == null) {
    box.innerHTML = `<div class="empty">Failed to load ADFs — check Settings / SSH</div>`;
    return;
  }
  log(out.trimEnd());
  const items = parseAdfLines(out);
  if (!items.length) {
    box.innerHTML = `<div class="empty">No .adf files found.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.dataset.adfName = it.name;
    row.innerHTML = `<div class="list-item-meta"><span class="idx">${it.idx}.</span><span class="adf-star" hidden aria-label="Now playing"></span><span class="name"></span></div>`;
    row.querySelector(".name")!.textContent = it.name;

    const actions = document.createElement("div");
    actions.className = "list-item-actions";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "play";
    playBtn.dataset.adfName = it.name;
    playBtn.dataset.adfIdx = it.idx;
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-pressed", "false");
    playBtn.addEventListener("click", async () => {
      log(`Playing #${it.idx} ${it.name}…`);
      // Immediate feedback while launch runs
      setPlayingAdf(it.name);
      const r = await run<string>("ra_play", { pick: it.idx });
      if (r != null) {
        log(r.trimEnd());
        setPlayingAdf(it.name);
      } else {
        // Launch failed — clear highlight if this was the only candidate
        if (playingAdfName === it.name) setPlayingAdf(null);
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove";
    removeBtn.textContent = "Remove";
    removeBtn.title = `Delete ${it.name} from the TV`;
    removeBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        `Remove "${it.name}" from the TV?\n\nThis deletes the .adf under the disks folder and cannot be undone.`,
      );
      if (!ok) return;
      log(`Removing #${it.idx} ${it.name}…`);
      const r = await run<string>("ra_remove", { pick: it.idx });
      if (r != null) {
        log(r.trimEnd());
        if (playingAdfName === it.name) playingAdfName = null;
        await reloadAdfs();
      }
    });

    actions.appendChild(playBtn);
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    box.appendChild(row);
  }
  // Restore green highlight after rebuild
  if (playingAdfName) setPlayingAdf(playingAdfName);
}

async function reloadCores(opts?: { busy?: boolean }) {
  const el = $("core-list");
  el.textContent = "Loading cores…";
  const out = await run<string>("ra_list_cores", undefined, {
    busy: opts?.busy !== false,
  });
  if (out == null) {
    el.textContent = "(failed — check Settings / SSH)";
    return;
  }
  el.textContent = out.trimEnd();
  log(out.trimEnd());
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
  const r = await run<string>("ra_upload_adfs", { paths: adfs });
  if (r != null) {
    log(r.trimEnd());
    await reloadAdfs();
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

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  const sel = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (sel && sel.value !== theme) sel.value = theme;
}

function initTheme() {
  let theme: ThemeId = "midnight";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "tokyo-night" || saved === "midnight") {
      theme = saved;
    }
  } catch {
    /* ignore */
  }
  applyTheme(theme);
  const sel = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (sel) {
    sel.value = theme;
    sel.addEventListener("change", () => {
      const v = sel.value;
      if (v === "light" || v === "tokyo-night" || v === "midnight") {
        applyTheme(v);
      }
    });
  }
  // Sync if another window (mouse) or tab changes theme
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY && e.newValue) {
      const v = e.newValue;
      if (v === "light" || v === "tokyo-night" || v === "midnight") {
        document.documentElement.setAttribute("data-theme", v);
        if (sel) sel.value = v;
      }
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
  $("btn-cores-list-all").addEventListener("click", () => {
    void listAllAvailableCores();
  });
  $input("core-filter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void listAllAvailableCores();
    }
  });
  $("btn-install-kickstart").addEventListener("click", () => {
    void installKickstartFromUrl();
  });
  $("btn-kickstart-example").addEventListener("click", () => {
    $input("kickstart-url").value = EXAMPLE_KICKSTART_URL;
    log("Kickstart URL set to A500 example (kick34005.A500).");
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
    $("conn-badge").textContent = `${s.user}@${s.host}`;
  });

  $("btn-status").addEventListener("click", () => void status());
  $("btn-adfs").addEventListener("click", () => void reloadAdfs());
  $("btn-adf-add").addEventListener("click", () => void pickAndUploadAdfs());
  $("btn-cores").addEventListener("click", () => void reloadCores());

  // Archive.org catalog browser
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
  $("btn-catalog-prev").addEventListener("click", () => {
    catalogOffset = Math.max(0, catalogOffset - CATALOG_PAGE);
    if (catalogMode === "search") void runCatalogSearch();
    else void loadCatalogAdfs();
  });
  $("btn-catalog-next").addEventListener("click", () => {
    if (catalogOffset + CATALOG_PAGE < catalogTotal) {
      catalogOffset += CATALOG_PAGE;
      if (catalogMode === "search") void runCatalogSearch();
      else void loadCatalogAdfs();
    }
  });
  $("btn-catalog-install").addEventListener("click", () => {
    void installCatalogAdfs(selectedCatalogIds());
  });
  $("btn-clear").addEventListener("click", () => {
    $("log").textContent = "";
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
      const act = btn.dataset.act!;
      const map: Record<string, string> = {
        launch: "ra_launch",
        close: "ra_close",
        kill: "ra_kill",
        restart: "ra_restart",
      };
      const cmd = map[act];
      if (!cmd) return;
      log(`${act}…`);
      const r = await run<string>(cmd);
      if (r != null) log(r.trimEnd());
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
  $("conn-badge").textContent = `${s.user}@${s.host}`;
  const keyOk = s.sshKey
    ? await invoke<boolean>("path_exists", { path: s.sshKey })
    : false;
  if (!keyOk) {
    // Defer settings until disclaimer is accepted so disclaimer stays on top
    if (hasAcceptedDisclaimer()) showSettings(true);
    else openSettingsAfterDisclaimer = true;
    log("Configure SSH host and private key in Settings, then Test SSH.");
    // Sites list does not need SSH
    void loadCatalogSites();
  } else {
    // Background refresh — never block window open / main thread beachball
    log("Connecting to TV in background…");
    $("adf-list").innerHTML = `<div class="empty">Loading ADFs from TV…</div>`;
    $("core-list").textContent = "Loading cores…";
    $("catalog-sites").innerHTML = `<div class="empty">Loading sites…</div>`;
    void (async () => {
      // Run in parallel; each SSH is off the UI thread in Rust
      await Promise.all([
        status(),
        reloadAdfs({ busy: false }),
        reloadCores({ busy: false }),
        loadCatalogSites(),
        setDefaultTvVolume(),
      ]);
    })();
  }
});
