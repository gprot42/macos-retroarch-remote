//! RetroArch Control — macOS helper for webOS (and future targets).
//! Shells out to the existing `webos/control-retroarch.sh` for reliability.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    pub host: String,
    pub user: String,
    pub ssh_key: String,
    pub port: u16,
    /// Absolute path to control-retroarch.sh (on the Mac)
    pub script_path: String,
    /// Optional extra SSH options (space-separated), e.g. `-o ProxyJump=bastion`
    #[serde(default)]
    pub ssh_extra: String,
    /// RetroArch config root on the TV
    #[serde(default = "default_ra_dir")]
    pub ra_dir: String,
    /// Amiga .adf disk images directory on the TV
    #[serde(default = "default_disks_dir")]
    pub disks_dir: String,
    /// Kickstart BIOS (system) directory on the TV
    #[serde(default = "default_system_dir")]
    pub system_dir: String,
    /// PUAE core path on the TV
    #[serde(default = "default_core_path")]
    pub core_path: String,
}

fn default_app_ra() -> String {
    "/media/developer/apps/usr/palm/applications/com.retroarch.webos/.config/retroarch".into()
}

fn default_ra_dir() -> String {
    default_app_ra()
}

fn default_disks_dir() -> String {
    format!("{}/disks/amiga", default_app_ra())
}

fn default_system_dir() -> String {
    format!("{}/system", default_app_ra())
}

fn default_core_path() -> String {
    format!("{}/cores/puae2021_libretro.so", default_app_ra())
}

impl Default for ConnectionSettings {
    fn default() -> Self {
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let script = [
            home.join("src/RetroArch/webos/control-retroarch.sh"),
            home.join("src/retroarch/webos/control-retroarch.sh"),
        ]
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| home.join("src/RetroArch/webos/control-retroarch.sh"));

        Self {
            host: "192.168.0.79".into(),
            user: "root".into(),
            ssh_key: home.join(".ssh/webos_deploy").display().to_string(),
            port: 22,
            script_path: script.display().to_string(),
            ssh_extra: String::new(),
            ra_dir: default_ra_dir(),
            disks_dir: default_disks_dir(),
            system_dir: default_system_dir(),
            core_path: default_core_path(),
        }
    }
}

fn expand_path(p: &str) -> PathBuf {
    let p = p.trim();
    if p.is_empty() {
        return PathBuf::new();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs_next::home_dir() {
            return home.join(rest);
        }
    }
    if p == "~" {
        return dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    }
    PathBuf::from(p)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn load_settings_file(app: &tauri::AppHandle) -> ConnectionSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return ConnectionSettings::default(),
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ConnectionSettings::default(),
    }
}

fn save_settings_file(app: &tauri::AppHandle, settings: &ConnectionSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("write settings: {e}"))?;
    Ok(())
}

fn run_control(settings: &ConnectionSettings, args: &[&str]) -> Result<String, String> {
    let script = expand_path(&settings.script_path);
    if !script.is_file() {
        return Err(format!(
            "control script not found:\n{}\n\nOpen Settings and set the path to control-retroarch.sh",
            script.display()
        ));
    }
    let key = expand_path(&settings.ssh_key);
    if !key.is_file() {
        return Err(format!(
            "SSH key not found:\n{}\n\nOpen Settings and pick your private key (e.g. ~/.ssh/webos_deploy)",
            key.display()
        ));
    }

    let mut cmd = Command::new("bash");
    cmd.arg(&script)
        .args(args)
        .env("WEBOS_HOST", settings.host.trim())
        .env("WEBOS_USER", settings.user.trim())
        .env("WEBOS_SSH_KEY", key.display().to_string())
        .env("WEBOS_SSH_PORT", settings.port.to_string());

    if !settings.ssh_extra.trim().is_empty() {
        cmd.env("WEBOS_SSH_EXTRA", settings.ssh_extra.trim());
    }
    // Paths on the TV (Amiga content / BIOS / core)
    if !settings.ra_dir.trim().is_empty() {
        cmd.env("WEBOS_RA_DIR", settings.ra_dir.trim());
    }
    if !settings.disks_dir.trim().is_empty() {
        cmd.env("WEBOS_DISKS_DIR", settings.disks_dir.trim());
    }
    if !settings.system_dir.trim().is_empty() {
        cmd.env("WEBOS_SYSTEM_DIR", settings.system_dir.trim());
    }
    if !settings.core_path.trim().is_empty() {
        cmd.env("WEBOS_CORE_PATH", settings.core_path.trim());
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to run script: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr}{stdout}")
    };

    if !output.status.success() {
        return Err(if combined.trim().is_empty() {
            format!("command failed (exit {:?})", output.status.code())
        } else {
            combined
        });
    }
    Ok(combined)
}

/// Run blocking SSH/control work off the main thread so the UI never beachballs.
async fn run_control_async(
    settings: ConnectionSettings,
    args: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_control(&settings, &refs)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Shared SSH/SCP client options (key, timeouts, extras).
fn ssh_client_opts(settings: &ConnectionSettings) -> Result<(PathBuf, String, String), String> {
    let key = expand_path(&settings.ssh_key);
    if !key.is_file() {
        return Err(format!("SSH key not found: {}", key.display()));
    }
    let host = settings.host.trim().to_string();
    let user = settings.user.trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Err("host and user are required".into());
    }
    Ok((key, user, host))
}

fn apply_ssh_common(cmd: &mut Command, settings: &ConnectionSettings, key: &Path) {
    cmd.arg("-i")
        .arg(key)
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=15")
        .arg("-o")
        .arg("ServerAliveInterval=5")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    for part in settings.ssh_extra.split_whitespace() {
        cmd.arg(part);
    }
}

/// Direct SSH connectivity check (does not require control script).
fn test_ssh(settings: &ConnectionSettings) -> Result<String, String> {
    let (key, user, host) = ssh_client_opts(settings)?;
    let target = format!("{user}@{host}");
    let mut cmd = Command::new("ssh");
    apply_ssh_common(&mut cmd, settings, &key);
    cmd.arg("-p")
        .arg(settings.port.to_string())
        .arg(&target)
        .arg("echo OK && uname -a && hostname 2>/dev/null || true");

    let output = cmd
        .output()
        .map_err(|e| format!("ssh failed to start: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "SSH connection failed:\n{}{}",
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\n{stdout}")
            }
        ));
    }
    Ok(format!(
        "SSH test passed → {target}:{}\n{}",
        settings.port,
        stdout.trim()
    ))
}

/// Shell-escape a remote path for use inside double quotes on the TV.
fn shell_single_quote(s: &str) -> String {
    // 'foo'bar' → 'foo'"'"'bar'
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Upload local .adf files to the TV disks directory via scp.
fn upload_adfs(settings: &ConnectionSettings, local_paths: &[String]) -> Result<String, String> {
    if local_paths.is_empty() {
        return Err("no files selected".into());
    }
    let (key, user, host) = ssh_client_opts(settings)?;
    let disks = settings.disks_dir.trim();
    if disks.is_empty() {
        return Err("ADF disks directory is not set (open Settings)".into());
    }
    if disks.contains('\n') || disks.contains('\0') {
        return Err("invalid disks directory path".into());
    }

    let mut files: Vec<PathBuf> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for raw in local_paths {
        let p = expand_path(raw);
        if !p.is_file() {
            return Err(format!("file not found: {}", p.display()));
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid file name: {}", p.display()))?
            .to_string();
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".adf") {
            return Err(format!("not an .adf file: {name}"));
        }
        // avoid path tricks in remote basename
        if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
            return Err(format!("unsafe file name: {name}"));
        }
        files.push(p);
        names.push(name);
    }

    let target = format!("{user}@{host}");
    let remote_dir_q = shell_single_quote(disks);

    // Ensure remote disks directory exists
    let mut mkdir = Command::new("ssh");
    apply_ssh_common(&mut mkdir, settings, &key);
    mkdir
        .arg("-p")
        .arg(settings.port.to_string())
        .arg(&target)
        .arg(format!("mkdir -p -- {remote_dir_q}"));
    let mkdir_out = mkdir
        .output()
        .map_err(|e| format!("ssh mkdir failed to start: {e}"))?;
    if !mkdir_out.status.success() {
        let err = String::from_utf8_lossy(&mkdir_out.stderr);
        return Err(format!("could not create disks dir on TV:\n{err}"));
    }

    // scp local files → user@host:disks_dir/
    let mut scp = Command::new("scp");
    apply_ssh_common(&mut scp, settings, &key);
    scp.arg("-P").arg(settings.port.to_string());
    for f in &files {
        scp.arg(f);
    }
    // trailing slash = copy into directory
    scp.arg(format!("{target}:{disks}/"));

    let scp_out = scp
        .output()
        .map_err(|e| format!("scp failed to start: {e}"))?;
    if !scp_out.status.success() {
        let stderr = String::from_utf8_lossy(&scp_out.stderr);
        let stdout = String::from_utf8_lossy(&scp_out.stdout);
        return Err(format!(
            "scp upload failed:\n{}{}",
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\n{stdout}")
            }
        ));
    }

    let list = names
        .iter()
        .map(|n| format!("  • {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "Uploaded {} file(s) → {disks}/\n{list}",
        names.len()
    ))
}

/// Resolve `setup-amiga.sh` next to `control-retroarch.sh` (or common defaults).
fn setup_amiga_script(settings: &ConnectionSettings) -> Result<PathBuf, String> {
    let control = expand_path(&settings.script_path);
    let candidates = [
        control.parent().map(|p| p.join("setup-amiga.sh")),
        dirs_next::home_dir().map(|h| h.join("src/RetroArch/webos/setup-amiga.sh")),
        dirs_next::home_dir().map(|h| h.join("src/retroarch/webos/setup-amiga.sh")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err(format!(
        "setup-amiga.sh not found next to control script:\n{}\n\nExpected …/webos/setup-amiga.sh",
        control.display()
    ))
}

fn apply_webos_env(cmd: &mut Command, settings: &ConnectionSettings, key: &Path) {
    cmd.env("WEBOS_HOST", settings.host.trim())
        .env("WEBOS_USER", settings.user.trim())
        .env("WEBOS_SSH_KEY", key.display().to_string())
        .env("WEBOS_SSH_PORT", settings.port.to_string());
    if !settings.ssh_extra.trim().is_empty() {
        cmd.env("WEBOS_SSH_EXTRA", settings.ssh_extra.trim());
    }
    if !settings.ra_dir.trim().is_empty() {
        cmd.env("WEBOS_RA_DIR", settings.ra_dir.trim());
    }
    if !settings.disks_dir.trim().is_empty() {
        cmd.env("WEBOS_DISKS_DIR", settings.disks_dir.trim());
    }
    if !settings.system_dir.trim().is_empty() {
        cmd.env("WEBOS_SYSTEM_DIR", settings.system_dir.trim());
    }
}

fn run_setup_amiga(settings: &ConnectionSettings, args: &[&str]) -> Result<String, String> {
    let script = setup_amiga_script(settings)?;
    let key = expand_path(&settings.ssh_key);
    // list-sites / list catalog do not need the key; install does
    let mut cmd = Command::new("bash");
    cmd.arg(&script).args(args);
    if key.is_file() {
        apply_webos_env(&mut cmd, settings, &key);
    } else {
        // still pass host/paths for listing messages
        cmd.env("WEBOS_HOST", settings.host.trim())
            .env("WEBOS_USER", settings.user.trim())
            .env("WEBOS_SSH_PORT", settings.port.to_string());
        if !settings.disks_dir.trim().is_empty() {
            cmd.env("WEBOS_DISKS_DIR", settings.disks_dir.trim());
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to run setup-amiga.sh: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout.clone()
    } else if stdout.is_empty() {
        stderr.clone()
    } else {
        format!("{stderr}{stdout}")
    };
    if !output.status.success() {
        return Err(if combined.trim().is_empty() {
            format!("setup-amiga failed (exit {:?})", output.status.code())
        } else {
            combined
        });
    }
    // Prefer stdout for --machine parsers
    if !stdout.trim().is_empty() {
        Ok(stdout)
    } else {
        Ok(combined)
    }
}

async fn run_setup_amiga_async(
    settings: ConnectionSettings,
    args: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_setup_amiga(&settings, &refs)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
fn default_settings() -> ConnectionSettings {
    ConnectionSettings::default()
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> ConnectionSettings {
    load_settings_file(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: ConnectionSettings) -> Result<String, String> {
    // Basic validation
    if settings.host.trim().is_empty() {
        return Err("Host is required".into());
    }
    if settings.user.trim().is_empty() {
        return Err("SSH user is required".into());
    }
    if settings.port == 0 {
        return Err("Port must be 1–65535".into());
    }
    save_settings_file(&app, &settings)?;
    let path = settings_path(&app)?;
    Ok(format!("Settings saved to\n{}", path.display()))
}

#[tauri::command]
async fn test_ssh_connection(settings: ConnectionSettings) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || test_ssh(&settings))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    expand_path(&path).exists()
}

/// Expand `~` and return absolute path string (for UI).
#[tauri::command]
fn resolve_path(path: String) -> String {
    expand_path(&path).display().to_string()
}

/// Common default locations for the webOS deploy key (for UI hints).
#[tauri::command]
fn default_ssh_key_candidates() -> Vec<String> {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let candidates = [
        home.join(".ssh/webos_deploy"),
        home.join(".ssh/id_ed25519"),
        home.join(".ssh/id_rsa"),
        home.join(".ssh/webos_tv"),
    ];
    candidates
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}

#[tauri::command]
async fn ra_status(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["status".into()]).await
}

#[tauri::command]
async fn ra_launch(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["launch".into()]).await
}

#[tauri::command]
async fn ra_close(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["close".into()]).await
}

#[tauri::command]
async fn ra_kill(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["kill".into()]).await
}

#[tauri::command]
async fn ra_restart(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["restart".into()]).await
}

#[tauri::command]
async fn ra_list_adfs(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["adfs".into()]).await
}

#[tauri::command]
async fn ra_list_cores(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["cores".into()]).await
}

/// Installed cores as machine lines: id|file|label|path
#[tauri::command]
async fn ra_list_cores_machine(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["cores-machine".into()]).await
}

/// All downloadable cores from webosbrew (file|label), optional filter text.
#[tauri::command]
async fn ra_list_available_cores(
    settings: ConnectionSettings,
    filter: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["cores-available".into()];
    if let Some(f) = filter {
        let t = f.trim();
        if !t.is_empty() {
            args.push(t.into());
        }
    }
    run_control_async(settings, args).await
}

/// Download + install one core onto the TV (e.g. puae2021_libretro.so).
#[tauri::command]
async fn ra_install_core(settings: ConnectionSettings, name: String) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("core name required (e.g. puae2021_libretro.so)".into());
    }
    if n.len() > 120 || n.contains("..") || n.contains('/') || n.contains('\\') {
        return Err("invalid core name".into());
    }
    run_control_async(settings, vec!["install-core".into(), n.into()]).await
}

/// Install Kickstart BIOS from URL(s) via setup-amiga.sh --kickstart-url.
/// Example: https://raw.githubusercontent.com/Abdess/retrobios/main/bios/Commodore/Amiga/kick34005.A500
#[tauri::command]
async fn amiga_install_kickstart(
    settings: ConnectionSettings,
    urls: Vec<String>,
) -> Result<String, String> {
    if urls.is_empty() {
        return Err("at least one Kickstart URL required".into());
    }
    let mut args = vec![
        "--skip-free".into(),
        "--yes".into(),
    ];
    for u in urls {
        let t = u.trim();
        if t.is_empty() {
            continue;
        }
        if !(t.starts_with("http://") || t.starts_with("https://") || t.contains("=http")) {
            return Err(format!("invalid kickstart URL: {t}"));
        }
        args.push("--kickstart-url".into());
        args.push(t.into());
    }
    if args.len() <= 2 {
        return Err("at least one Kickstart URL required".into());
    }
    run_setup_amiga_async(settings, args).await
}

#[tauri::command]
async fn ra_list_roms(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["roms".into()]).await
}

#[tauri::command]
async fn ra_play(settings: ConnectionSettings, pick: String) -> Result<String, String> {
    if pick.trim().is_empty() {
        return Err("pick a disk number or name".into());
    }
    run_control_async(settings, vec!["play".into(), pick.trim().into()]).await
}

#[tauri::command]
async fn ra_remove(settings: ConnectionSettings, pick: String) -> Result<String, String> {
    if pick.trim().is_empty() {
        return Err("pick a disk number or name to remove".into());
    }
    run_control_async(settings, vec!["remove".into(), pick.trim().into()]).await
}

/// Pick local .adf path(s) already chosen in the UI; copy them to the TV disks dir.
#[tauri::command]
async fn ra_upload_adfs(
    settings: ConnectionSettings,
    paths: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || upload_adfs(&settings, &paths))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCatalogSite {
    /// Archive.org item identifier
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub desc: String,
    /// Original URL or id as entered by the user
    #[serde(default)]
    pub url: String,
}

fn custom_catalog_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("custom-catalog-sites.json"))
}

fn load_custom_catalog_file(app: &tauri::AppHandle) -> Vec<CustomCatalogSite> {
    let path = match custom_catalog_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Parse Archive.org details/download URL or bare item id.
fn parse_archive_org_id(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty site URL / id".into());
    }
    // https://archive.org/details/ITEM or /download/ITEM/...
    if let Some(rest) = raw
        .find("archive.org/details/")
        .map(|i| &raw[i + "archive.org/details/".len()..])
        .or_else(|| {
            raw.find("archive.org/download/")
                .map(|i| &raw[i + "archive.org/download/".len()..])
        })
    {
        let id = rest
            .split(&['/', '?', '#'][..])
            .next()
            .unwrap_or("")
            .trim();
        if id.is_empty() {
            return Err("could not parse item id from URL".into());
        }
        return Ok(id.to_string());
    }
    // bare identifier
    if raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && raw
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
    {
        return Ok(raw.to_string());
    }
    Err("expected Archive.org item id or https://archive.org/details/… URL".into())
}

/// Builtin sites from setup-amiga.sh (--list-sites --machine).
#[tauri::command]
async fn amiga_list_sites(
    settings: ConnectionSettings,
    category: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["--list-sites".into(), "--machine".into()];
    if let Some(c) = category {
        let c = c.trim().to_ascii_lowercase();
        if !c.is_empty() && c != "all" {
            args.push("--category".into());
            args.push(c);
        }
    }
    run_setup_amiga_async(settings, args).await
}

#[tauri::command]
fn amiga_list_custom_sites(app: tauri::AppHandle) -> Vec<CustomCatalogSite> {
    load_custom_catalog_file(&app)
}

/// Add a custom Archive.org catalog site (URL or item id).
#[tauri::command]
fn amiga_add_custom_site(
    app: tauri::AppHandle,
    url: String,
    label: Option<String>,
) -> Result<CustomCatalogSite, String> {
    let id = parse_archive_org_id(&url)?;
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    let site = CustomCatalogSite {
        id: id.clone(),
        label,
        desc: "Custom Archive.org site".into(),
        url: url.trim().to_string(),
    };
    let mut list = load_custom_catalog_file(&app);
    // replace if same id already present
    list.retain(|s| s.id != site.id);
    list.push(site.clone());
    let path = custom_catalog_path(&app)?;
    let raw = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("write custom sites: {e}"))?;
    Ok(site)
}

#[tauri::command]
fn amiga_remove_custom_site(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("missing site id".into());
    }
    let mut list = load_custom_catalog_file(&app);
    let before = list.len();
    list.retain(|s| s.id != id);
    if list.len() == before {
        return Err(format!("custom site not found: {id}"));
    }
    let path = custom_catalog_path(&app)?;
    let raw = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("write custom sites: {e}"))?;
    Ok(())
}

/// Page of ADFs for a site (--list --machine --site …).
#[tauri::command]
async fn amiga_list_adfs(
    settings: ConnectionSettings,
    site: String,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    refresh: Option<bool>,
) -> Result<String, String> {
    let site = site.trim();
    if site.is_empty() {
        return Err("pick a catalog site first".into());
    }
    let mut args = vec![
        "--list".into(),
        "--machine".into(),
        "--site".into(),
        site.into(),
        "--limit".into(),
        limit.unwrap_or(40).clamp(1, 200).to_string(),
        "--offset".into(),
        offset.unwrap_or(0).to_string(),
    ];
    if let Some(s) = search {
        let s = s.trim();
        if !s.is_empty() {
            args.push("--search".into());
            args.push(s.into());
        }
    }
    if refresh.unwrap_or(false) {
        args.push("--refresh".into());
    }
    run_setup_amiga_async(settings, args).await
}

/// Download selected page indexes and install to the TV.
#[tauri::command]
async fn amiga_install_adfs(
    settings: ConnectionSettings,
    site: String,
    ids: Vec<u32>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<String, String> {
    let site = site.trim();
    if site.is_empty() {
        return Err("pick a catalog site first".into());
    }
    if ids.is_empty() {
        return Err("select at least one ADF to install".into());
    }
    let mut args = vec![
        "--yes".into(),
        "--site".into(),
        site.into(),
        "--limit".into(),
        limit.unwrap_or(40).clamp(1, 200).to_string(),
        "--offset".into(),
        offset.unwrap_or(0).to_string(),
        "--ids".into(),
    ];
    for id in ids {
        args.push(id.to_string());
    }
    if let Some(s) = search {
        let s = s.trim();
        if !s.is_empty() {
            args.push("--search".into());
            args.push(s.into());
        }
    }
    // Install needs the SSH key
    let key = expand_path(&settings.ssh_key);
    if !key.is_file() {
        return Err(format!("SSH key not found: {}", key.display()));
    }
    run_setup_amiga_async(settings, args).await
}

/// One catalog ADF to install by direct download URL (preferred GUI path).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdfInstallItem {
    pub url: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub title: String,
}

/// Install ADFs from Archive.org file URLs already shown in the UI.
/// Avoids re-searching the catalog (broken on titles with `$` `[]` etc.).
#[tauri::command]
async fn amiga_install_urls(
    settings: ConnectionSettings,
    items: Vec<AdfInstallItem>,
) -> Result<String, String> {
    if items.is_empty() {
        return Err("select at least one ADF to install".into());
    }
    let key = expand_path(&settings.ssh_key);
    if !key.is_file() {
        return Err(format!("SSH key not found: {}", key.display()));
    }
    let mut args = vec!["--yes".into(), "--skip-kickstarts".into()];
    for it in items {
        let url = it.url.trim();
        if url.is_empty() {
            continue;
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(format!("invalid download URL: {url}"));
        }
        args.push("--install-url".into());
        args.push(url.into());
        let name = it.file.trim();
        if !name.is_empty() {
            args.push("--install-name".into());
            args.push(name.into());
        }
    }
    if args.len() <= 2 {
        return Err("no valid download URLs".into());
    }
    run_setup_amiga_async(settings, args).await
}

/// Search titles across games / demos / utilities catalogs.
#[tauri::command]
async fn amiga_search_adfs(
    settings: ConnectionSettings,
    search: String,
    category: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    refresh: Option<bool>,
) -> Result<String, String> {
    let q = search.trim();
    if q.is_empty() {
        return Err("enter a search term (game, demo, or utility name)".into());
    }
    let mut args = vec![
        "--search-all".into(),
        "--machine".into(),
        "--search".into(),
        q.into(),
        "--limit".into(),
        limit.unwrap_or(40).clamp(1, 200).to_string(),
        "--offset".into(),
        offset.unwrap_or(0).to_string(),
    ];
    if let Some(c) = category {
        let c = c.trim().to_ascii_lowercase();
        if !c.is_empty() && c != "all" {
            args.push("--category".into());
            args.push(c);
        }
    }
    if refresh.unwrap_or(false) {
        args.push("--refresh".into());
    }
    run_setup_amiga_async(settings, args).await
}

#[tauri::command]
async fn ra_click_left(
    settings: ConnectionSettings,
    times: Option<u32>,
) -> Result<String, String> {
    let n = times.unwrap_or(1).clamp(1, 50).to_string();
    run_control_async(settings, vec!["click-left".into(), n]).await
}

#[tauri::command]
async fn ra_click_right(
    settings: ConnectionSettings,
    times: Option<u32>,
) -> Result<String, String> {
    let n = times.unwrap_or(1).clamp(1, 50).to_string();
    run_control_async(settings, vec!["click-right".into(), n]).await
}

#[tauri::command]
async fn ra_mouse_move(
    settings: ConnectionSettings,
    dx: i32,
    dy: i32,
) -> Result<String, String> {
    run_control_async(
        settings,
        vec!["mouse-move".into(), dx.to_string(), dy.to_string()],
    )
    .await
}

#[tauri::command]
async fn ra_mouse_button(
    settings: ConnectionSettings,
    action: String,
    button: String,
) -> Result<String, String> {
    let act = match action.as_str() {
        "up" => "mouse-up",
        _ => "mouse-down",
    };
    run_control_async(settings, vec![act.into(), button]).await
}

/// Send a keyboard key to the TV (esc / enter, or full virtual-keyboard names).
#[tauri::command]
async fn ra_key(settings: ConnectionSettings, key: String) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("key required".into());
    }
    let lower = k.to_ascii_lowercase();
    // Keep legacy short path for esc/enter
    if matches!(lower.as_str(), "esc" | "escape" | "enter" | "return" | "ret" | "ok") {
        let name = match lower.as_str() {
            "esc" | "escape" => "esc",
            _ => "enter",
        };
        return run_control_async(settings, vec!["key".into(), name.into()]).await;
    }
    run_control_async(settings, vec!["keyboard-key".into(), k.into()]).await
}

/// Virtual keyboard key; optional shift for named keys.
#[tauri::command]
async fn ra_keyboard_key(
    settings: ConnectionSettings,
    key: String,
    shift: Option<bool>,
) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("key required".into());
    }
    if k.len() > 32 {
        return Err("key name too long".into());
    }
    let mut args = vec!["keyboard-key".into(), k.into()];
    if shift.unwrap_or(false) {
        args.push("1".into());
    }
    run_control_async(settings, args).await
}

/// Type an ASCII string on the TV (Shift applied as needed).
#[tauri::command]
async fn ra_type_text(settings: ConnectionSettings, text: String) -> Result<String, String> {
    if text.is_empty() {
        return Err("text required".into());
    }
    if text.len() > 500 {
        return Err("text too long (max 500 chars)".into());
    }
    run_control_async(settings, vec!["type-text".into(), text]).await
}

/// Force-show the webOS on-screen pointer (Magic Remote cursor).
#[tauri::command]
async fn ra_show_cursor(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["show-cursor".into()]).await
}

/// Magic Remote / SSAP-style button (UP, DOWN, ENTER, BACK, HOME, VOLUMEUP, …).
#[tauri::command]
async fn ra_remote_button(settings: ConnectionSettings, button: String) -> Result<String, String> {
    let b = button.trim();
    if b.is_empty() {
        return Err("button name required".into());
    }
    // basic sanitise — script does the rest
    if b.len() > 40 {
        return Err("button name too long".into());
    }
    run_control_async(settings, vec!["remote-button".into(), b.into()]).await
}

/// Current TV volume: JSON `{"volume":N,"muted":bool}` from setup script stdout.
#[tauri::command]
async fn ra_volume_get(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["volume-get".into()]).await
}

/// Step TV volume (shows on-TV OSD). JSON `{"volume":N,"muted":bool}` after step.
#[tauri::command]
async fn ra_volume_step(
    settings: ConnectionSettings,
    direction: String,
    steps: Option<u32>,
) -> Result<String, String> {
    let dir = direction.trim().to_ascii_lowercase();
    let cmd = match dir.as_str() {
        "up" | "+" => "volume-up",
        "down" | "-" => "volume-down",
        _ => return Err("direction must be up or down".into()),
    };
    let n = steps.unwrap_or(1).clamp(1, 20).to_string();
    run_control_async(settings, vec![cmd.into(), n]).await
}

/// Set absolute TV volume 0–100. JSON after set.
#[tauri::command]
async fn ra_volume_set(settings: ConnectionSettings, level: u32) -> Result<String, String> {
    let level = level.min(100);
    run_control_async(settings, vec!["volume-set".into(), level.to_string()]).await
}

#[tauri::command]
async fn ra_cmd(settings: ConnectionSettings, args: Vec<String>) -> Result<String, String> {
    if args.is_empty() {
        return Err("no args".into());
    }
    run_control_async(settings, args).await
}

/// Open (or focus) the combined Amiga mouse + keyboard control window.
#[tauri::command]
fn open_mouse_window(app: AppHandle) -> Result<(), String> {
    // Close legacy separate keyboard window if it was left open from an older build
    if let Some(kb) = app.get_webview_window("keyboard") {
        let _ = kb.close();
    }
    if let Some(w) = app.get_webview_window("mouse") {
        let _ = w.set_focus();
        let _ = w.unminimize();
        return Ok(());
    }
    let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:1420/mouse.html".parse().unwrap())
    } else {
        WebviewUrl::App("mouse.html".into())
    };
    WebviewWindowBuilder::new(&app, "mouse", url)
        .title("Amiga Control")
        // Side-by-side trackpad + full virtual keyboard
        .inner_size(960.0, 560.0)
        .min_inner_size(640.0, 420.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("open mouse window: {e}"))?;
    Ok(())
}

/// Open (or focus) the Magic Remote control window.
#[tauri::command]
fn open_remote_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("remote") {
        let _ = w.set_focus();
        let _ = w.unminimize();
        return Ok(());
    }
    let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:1420/remote.html".parse().unwrap())
    } else {
        WebviewUrl::App("remote.html".into())
    };
    WebviewWindowBuilder::new(&app, "remote", url)
        .title("TV Volume")
        .inner_size(280.0, 400.0)
        .min_inner_size(240.0, 340.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("open remote window: {e}"))?;
    Ok(())
}

/// Open the combined control window (keyboard is merged into mouse/Amiga control).
#[tauri::command]
fn open_keyboard_window(app: AppHandle) -> Result<(), String> {
    open_mouse_window(app)
}

// silence unused import if Path only used in expand
#[allow(dead_code)]
fn _path_ref(p: &Path) -> &Path {
    p
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_settings,
            load_settings,
            save_settings,
            test_ssh_connection,
            path_exists,
            resolve_path,
            default_ssh_key_candidates,
            ra_status,
            ra_launch,
            ra_close,
            ra_kill,
            ra_restart,
            ra_list_adfs,
            ra_list_cores,
            ra_list_cores_machine,
            ra_list_available_cores,
            ra_install_core,
            amiga_install_kickstart,
            ra_list_roms,
            ra_play,
            ra_remove,
            ra_upload_adfs,
            amiga_list_sites,
            amiga_list_custom_sites,
            amiga_add_custom_site,
            amiga_remove_custom_site,
            amiga_list_adfs,
            amiga_search_adfs,
            amiga_install_adfs,
            amiga_install_urls,
            ra_click_left,
            ra_click_right,
            ra_mouse_move,
            ra_mouse_button,
            ra_key,
            ra_keyboard_key,
            ra_type_text,
            ra_show_cursor,
            ra_remote_button,
            ra_volume_get,
            ra_volume_step,
            ra_volume_set,
            ra_cmd,
            open_mouse_window,
            open_remote_window,
            open_keyboard_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
