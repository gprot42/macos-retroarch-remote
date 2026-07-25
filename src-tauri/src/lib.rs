//! RetroArch Remote — macOS helper for webOS (and future targets).
//! Shells out to the existing `webos/control-retroarch.sh` for reliability.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, UdpSocket};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// Common locations for `control-retroarch.sh` / `setup-amiga.sh` on this Mac.
fn control_script_candidates(home: &Path) -> Vec<PathBuf> {
    let mut v = vec![
        home.join("src/public/RetroArch/webos/control-retroarch.sh"),
        home.join("src/RetroArch/webos/control-retroarch.sh"),
        home.join("src/retroarch/webos/control-retroarch.sh"),
        home.join("src/public/retroarch/webos/control-retroarch.sh"),
    ];
    // Optional override from start.sh / shell
    if let Ok(env) = std::env::var("WEBOS_CONTROL_SCRIPT") {
        let p = expand_path(&env);
        if !p.as_os_str().is_empty() {
            v.insert(0, p);
        }
    }
    v
}

fn resolve_control_script(home: &Path) -> PathBuf {
    control_script_candidates(home)
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| home.join("src/public/RetroArch/webos/control-retroarch.sh"))
}

impl Default for ConnectionSettings {
    fn default() -> Self {
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let script = resolve_control_script(&home);

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

fn control_command(settings: &ConnectionSettings, args: &[&str]) -> Result<Command, String> {
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
        // Never inherit stdin — can hang the whole app if a child waits for TTY input.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
    // Own process group so timeout kill can stop bash + ssh children.
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    Ok(cmd)
}

fn run_control(settings: &ConnectionSettings, args: &[&str]) -> Result<String, String> {
    let output = control_command(settings, args)?
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

/// Like `run_control`, but kills the child if it exceeds `timeout`.
/// Used for gamepad probes so a stuck SSH/luna path never freezes the UI indefinitely.
fn run_control_timeout(
    settings: &ConnectionSettings,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = control_command(settings, args)?
        .spawn()
        .map_err(|e| format!("failed to run script: {e}"))?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                let combined = if stderr.is_empty() {
                    stdout
                } else if stdout.is_empty() {
                    stderr
                } else {
                    format!("{stderr}{stdout}")
                };
                if !status.success() {
                    return Err(if combined.trim().is_empty() {
                        format!("command failed (exit {:?})", status.code())
                    } else {
                        combined
                    });
                }
                return Ok(combined);
            }
            Ok(None) if start.elapsed() >= timeout => {
                // Kill process group (bash + ssh) — child was started with process_group(0).
                let pid = child.id();
                let _ = Command::new("kill")
                    .args(["-KILL", &format!("-{pid}")])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "timed out after {}s ({})",
                    timeout.as_secs(),
                    args.first().unwrap_or(&"control")
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }
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

async fn run_control_async_timeout(
    settings: ConnectionSettings,
    args: Vec<String>,
    timeout: Duration,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_control_timeout(&settings, &refs, timeout)
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
        // Keep SSH short so dead TVs don't freeze the UI for a long time
        .arg("ConnectTimeout=8")
        .arg("-o")
        .arg("ServerAliveInterval=3")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    for part in settings.ssh_extra.split_whitespace() {
        cmd.arg(part);
    }
}

/// Reuse SSH ControlMaster so mouse/keyboard spam stays ~ms after the first call.
fn apply_ssh_mux(cmd: &mut Command) {
    cmd.arg("-o")
        .arg("ControlMaster=auto")
        .arg("-o")
        .arg("ControlPath=/tmp/ra-ssh-%h-%p")
        .arg("-o")
        .arg("ControlPersist=120");
}

/// Compact TV-side key inject (no full control-retroarch.sh).
/// Uses r## so `"#":` in the Python map does not terminate the string.
///
/// Amiga typing strategy:
/// - Prefer **CHECK INPUT** (open when RetroArch starts; SDL already listens).
/// - Single device only (multi-blast caused "hello"→"o").
/// - Slow holds; type_text_fast also spaces characters across separate SSH calls.
const TV_KEY_PY: &str = r##"
import os, struct, time as _t, sys, glob, errno
def pack(t, c, v):
    now = _t.time()
    sec = int(now)
    usec = int((now - sec) * 1e6)
    for fmt in ("llHHi", "IIHHi", "QQHHi"):
        try:
            return struct.pack(fmt, sec, usec, int(t), int(c), int(v))
        except struct.error:
            pass
    return struct.pack("llHHi", sec, usec, int(t), int(c), int(v))

# CHECK INPUT first — same device Return uses (SDL already has it open).
# Virtual keyboard only if present (must exist before RetroArch launch).
PREFER = (
    "CHECK INPUT",
    "RA Virtual Keyboard",
    "LGE Network Input",
    "Smart Remote RCU Input",
    "LGE RCU",
    "IoT keypad",
)
_KB_PATH = None
_KB_NAME = None

def ra_running():
    for d in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            c = open(d, "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
        except Exception:
            continue
        if "retroarch" in c.lower():
            return True
    return False

def kb_path():
    global _KB_PATH, _KB_NAME
    if _KB_PATH is not None and os.path.exists(_KB_PATH):
        return _KB_PATH
    by = {}
    for np in glob.glob("/sys/class/input/event*/device/name"):
        try:
            n = open(np).read().strip()
        except OSError:
            continue
        by[n] = "/dev/input/" + np.split("/")[4]
    for n in PREFER:
        if n in by and os.path.exists(by[n]):
            _KB_PATH = by[n]
            _KB_NAME = n
            return _KB_PATH
    raise SystemExit("no keyboard device (CHECK INPUT / LGE RCU missing)")

def kb_name():
    kb_path()
    return _KB_NAME or "?"

def _open_fd():
    return os.open(kb_path(), os.O_WRONLY)

def _write_ev(fd, typ, code, value):
    payload = pack(typ, code, value) + pack(0, 0, 0)
    for _ in range(30):
        try:
            os.write(fd, payload)
            return
        except OSError as e:
            if getattr(e, "errno", None) in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                _t.sleep(0.003)
                continue
            raise
    raise OSError("keyboard write failed")

# Amiga-safe holds. Letters need longer gaps than Return alone.
HOLD = 0.16
GAP = 0.08
SHIFT = 42

K = {
    "esc":1,"1":2,"2":3,"3":4,"4":5,"5":6,"6":7,"7":8,"8":9,"9":10,"0":11,
    "minus":12,"equal":13,"backspace":14,"tab":15,
    "q":16,"w":17,"e":18,"r":19,"t":20,"y":21,"u":22,"i":23,"o":24,"p":25,
    "lbrace":26,"rbrace":27,"enter":28,"ctrl":29,"leftctrl":29,"control":29,
    "a":30,"s":31,"d":32,"f":33,"g":34,
    "h":35,"j":36,"k":37,"l":38,"semicolon":39,"apostrophe":40,"grave":41,
    "shift":42,"leftshift":42,"backslash":43,"z":44,"x":45,"c":46,"v":47,"b":48,"n":49,"m":50,
    "comma":51,"dot":52,"slash":53,"rightshift":54,"alt":56,"leftalt":56,
    "space":57,"caps":58,"capslock":58,
    "f1":59,"f2":60,"f3":61,"f4":62,"f5":63,"f6":64,"f7":65,"f8":66,
    "f9":67,"f10":68,"f11":87,"f12":88,
    "up":103,"left":105,"right":106,"down":108,"delete":111,"del":111,
    "help":138,"insert":110,
    "amiga":125,"lamiga":125,"leftamiga":125,"leftmeta":125,"super":125,
    "ramiga":126,"rightamiga":126,"rightmeta":126,
}
CHARS = {
    "a":(30,0),"b":(48,0),"c":(46,0),"d":(32,0),"e":(18,0),"f":(33,0),"g":(34,0),"h":(35,0),
    "i":(23,0),"j":(36,0),"k":(37,0),"l":(38,0),"m":(50,0),"n":(49,0),"o":(24,0),"p":(25,0),
    "q":(16,0),"r":(19,0),"s":(31,0),"t":(20,0),"u":(22,0),"v":(47,0),"w":(17,0),"x":(45,0),
    "y":(21,0),"z":(44,0),
    "A":(30,1),"B":(48,1),"C":(46,1),"D":(32,1),"E":(18,1),"F":(33,1),"G":(34,1),"H":(35,1),
    "I":(23,1),"J":(36,1),"K":(37,1),"L":(38,1),"M":(50,1),"N":(49,1),"O":(24,1),"P":(25,1),
    "Q":(16,1),"R":(19,1),"S":(31,1),"T":(20,1),"U":(22,1),"V":(47,1),"W":(17,1),"X":(45,1),
    "Y":(21,1),"Z":(44,1),
    "1":(2,0),"2":(3,0),"3":(4,0),"4":(5,0),"5":(6,0),"6":(7,0),"7":(8,0),"8":(9,0),"9":(10,0),"0":(11,0),
    "!":(2,1),"@":(3,1),"#":(4,1),"$":(5,1),"%":(6,1),"^":(7,1),"&":(8,1),"*":(9,1),"(":(10,1),")":(11,1),
    "-":(12,0),"_":(12,1),"=":(13,0),"+":(13,1),"[":(26,0),"{":(26,1),"]":(27,0),"}":(27,1),
    ";":(39,0),":":(39,1),"'":(40,0),'"':(40,1),"`":(41,0),"~":(41,1),"\\":(43,0),"|":(43,1),
    ",":(51,0),"<":(51,1),".":(52,0),">":(52,1),"/":(53,0),"?":(53,1)," ":(57,0),
}

def release_mods(fd):
    """Only modifiers — never flood KEY_UP for a–z between letters."""
    for code in (42, 54, 29, 97, 56, 100, 125, 126):
        try:
            _write_ev(fd, 1, code, 0)
        except Exception:
            pass
    _t.sleep(0.02)

def tap(code, hold=None):
    if hold is None:
        hold = HOLD
    fd = _open_fd()
    try:
        release_mods(fd)
        _write_ev(fd, 1, code, 1)
        _t.sleep(hold)
        _write_ev(fd, 1, code, 0)
        _t.sleep(GAP)
    finally:
        os.close(fd)

def tap_shifted(code, hold=None):
    if hold is None:
        hold = HOLD
    fd = _open_fd()
    try:
        release_mods(fd)
        _write_ev(fd, 1, SHIFT, 1)
        _t.sleep(0.04)
        _write_ev(fd, 1, code, 1)
        _t.sleep(hold)
        _write_ev(fd, 1, code, 0)
        _t.sleep(0.03)
        _write_ev(fd, 1, SHIFT, 0)
        _t.sleep(GAP)
    finally:
        os.close(fd)

def do_key(raw, shift_flag):
    raw = raw or ""
    if len(raw) == 1 and raw in CHARS:
        code, need = CHARS[raw]
        if need or shift_flag:
            tap_shifted(code)
        else:
            tap(code)
        return
    n = raw.strip().lower()
    aliases = {
        "escape": "esc", "return": "enter", "bksp": "backspace",
        "bs": "backspace", "spc": "space", "del": "delete",
        "a500": "amiga", "commodore": "amiga", "cmd": "amiga",
        "meta": "amiga", "win": "amiga",
    }
    n = aliases.get(n, n)
    if n in K:
        if shift_flag:
            tap_shifted(K[n])
        else:
            tap(K[n])
        return
    raise RuntimeError("unknown key %r" % raw)

def type_string(text):
    """Type a full string on ONE open fd — clean down/up per char, no release flood."""
    fd = _open_fd()
    ok = 0
    skip = 0
    try:
        release_mods(fd)
        _t.sleep(0.05)
        for ch in text:
            if ch in ("\n", "\r"):
                code, need = 28, 0
            elif ch == "\t":
                code, need = 15, 0
            elif ch in CHARS:
                code, need = CHARS[ch]
            else:
                skip += 1
                continue
            try:
                if need:
                    _write_ev(fd, 1, SHIFT, 1)
                    _t.sleep(0.04)
                _write_ev(fd, 1, code, 1)
                _t.sleep(HOLD)
                _write_ev(fd, 1, code, 0)
                if need:
                    _t.sleep(0.03)
                    _write_ev(fd, 1, SHIFT, 0)
                ok += 1
                _t.sleep(GAP)
            except Exception as e:
                skip += 1
                sys.stderr.write("skip %r: %s\n" % (ch, e))
                try:
                    _write_ev(fd, 1, code, 0)
                    release_mods(fd)
                except Exception:
                    pass
        release_mods(fd)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return ok, skip, kb_name()
"##;

/// Run a short python snippet on the TV over SSH (muxed). Much faster than control-retroarch.sh.
fn run_tv_python(settings: &ConnectionSettings, script: &str) -> Result<String, String> {
    let (key, user, host) = ssh_client_opts(settings)?;
    let target = format!("{user}@{host}");
    let mut cmd = Command::new("ssh");
    apply_ssh_common(&mut cmd, settings, &key);
    apply_ssh_mux(&mut cmd);
    cmd.arg("-p")
        .arg(settings.port.to_string())
        .arg(&target)
        .arg("python3")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ssh spawn failed: {e}"))?;
    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("ssh stdin: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("ssh wait: {e}"))?;
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
            format!("ssh command failed (exit {:?})", output.status.code())
        } else {
            combined
        });
    }
    Ok(combined)
}

fn inject_key_fast(settings: &ConnectionSettings, key: &str, shift: bool) -> Result<String, String> {
    // Escape for embedding in a python string literal
    let escaped = key
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    let flag = if shift { "1" } else { "0" };
    let script = format!(
        "{TV_KEY_PY}\n_KB_PATH=None\n_KB_NAME=None\ndo_key('{escaped}', {flag})\nprint('ok key=%r shift=%s via=%s ra=%s' % ('{escaped}', {flag}, kb_name(), 'yes' if ra_running() else 'NO'))\n"
    );
    run_tv_python(settings, &script)
}

/// Compact ClickableMouse REL inject — no control-retroarch.sh (keeps mouse lag low).
const TV_MOUSE_PY: &str = r##"
import os, struct, time as _t, glob
def pack(t, c, v):
    now = _t.time(); sec = int(now); usec = int((now - sec) * 1e6)
    for fmt in ("llHHi", "IIHHi", "QQHHi"):
        try:
            return struct.pack(fmt, sec, usec, int(t), int(c), int(v))
        except struct.error:
            pass
    return struct.pack("llHHi", sec, usec, int(t), int(c), int(v))
CACHE = "/tmp/ra-mouse-ev"
def mouse_dev():
    if os.path.exists(CACHE):
        p = open(CACHE).read().strip()
        if p and os.path.exists(p):
            return p
    prefer = ("ClickableMouse", "clickable mouse", "LGE ClickableMouse")
    by = {}
    for np in glob.glob("/sys/class/input/event*/device/name"):
        try:
            n = open(np).read().strip()
        except OSError:
            continue
        by[n] = "/dev/input/" + np.split("/")[4]
    for n in prefer:
        if n in by:
            open(CACHE, "w").write(by[n]); return by[n]
    for name, path in by.items():
        low = name.lower()
        if "clickable" in low or ("mouse" in low and "lge" not in low and "remote" not in low):
            open(CACHE, "w").write(path); return path
    # any REL-capable device as last resort
    for np in glob.glob("/sys/class/input/event*/device/name"):
        base = np.rsplit("/name", 1)[0]
        try:
            rel = open(base + "/capabilities/rel").read().strip()
            if rel and rel != "0":
                p = "/dev/input/" + np.split("/")[4]
                open(CACHE, "w").write(p); return p
        except Exception:
            pass
    raise SystemExit("no mouse device")
def inject_rel(dx, dy):
    fd = os.open(mouse_dev(), os.O_WRONLY)
    try:
        body = b""
        if dx:
            body += pack(2, 0, int(dx))  # EV_REL REL_X
        if dy:
            body += pack(2, 1, int(dy))  # EV_REL REL_Y
        body += pack(0, 0, 0)  # SYN_REPORT
        os.write(fd, body)
    finally:
        os.close(fd)
"##;

fn inject_mouse_move_fast(
    settings: &ConnectionSettings,
    dx: i32,
    dy: i32,
) -> Result<String, String> {
    if dx == 0 && dy == 0 {
        return Ok("ok move dx=0 dy=0".into());
    }
    // Allow big swipes so one pad stroke can cross most of a 1080p screen
    let dx = dx.clamp(-400, 400);
    let dy = dy.clamp(-400, 400);
    let script = format!(
        "{TV_MOUSE_PY}\ninject_rel({dx}, {dy})\nprint('ok move dx={dx} dy={dy} via=evdev-fast')\n"
    );
    run_tv_python(settings, &script)
}

fn type_text_fast(settings: &ConnectionSettings, text: &str) -> Result<String, String> {
    // Same path as Return / single virtual keys: one inject_key_fast per character
    // with a long gap. Batch type_string was still dropped by PUAE/SDL for words.
    let mut ok = 0usize;
    let mut skip = 0usize;
    let mut last_via = String::from("?");
    let mut ra_no = false;
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        let key = if ch == '\n' {
            "enter".to_string()
        } else {
            ch.to_string()
        };
        match inject_key_fast(settings, &key, false) {
            Ok(msg) => {
                ok += 1;
                if msg.contains("ra=NO") {
                    ra_no = true;
                }
                if let Some(rest) = msg.split("via=").nth(1) {
                    last_via = rest
                        .split_whitespace()
                        .next()
                        .unwrap_or("?")
                        .to_string();
                }
            }
            Err(_) => skip += 1,
        }
        // Match the UI Send path: wait for PUAE to swallow each key
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    if ok == 0 {
        return Err("no characters typed — is the TV reachable over SSH?".into());
    }
    let mut msg = format!("ok typed={ok} skipped={skip} mode=per-key via={last_via}");
    if ra_no {
        msg.push_str(
            "\nWARN: RetroArch may not be running — Play Amiga, focus text field, Send again.",
        );
    }
    Ok(msg)
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
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = control.parent() {
        candidates.push(parent.join("setup-amiga.sh"));
    }
    // Same search roots as the control script (sibling setup-amiga.sh)
    for c in control_script_candidates(&home) {
        if let Some(parent) = c.parent() {
            let setup = parent.join("setup-amiga.sh");
            if !candidates.iter().any(|p| p == &setup) {
                candidates.push(setup);
            }
        }
    }
    for c in &candidates {
        if c.is_file() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "setup-amiga.sh not found.\n\
         Control script path:\n  {}\n\
         Looked next to it and under ~/src/public/RetroArch/webos/.\n\
         Open Settings → set Control script to …/webos/control-retroarch.sh\n\
         (setup-amiga.sh must live in that same folder).",
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
    cmd.arg(&script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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

// ── TV network repair (ported from macos-prime-remote-control) ─────────────
// Classic failure: TV visible / was at 192.168.0.79 but Mac ARP is incomplete
// ("visible but unreachable"). Fix: rediscover IP via mDNS, flush stale ARP/
// host route (admin prompt), optional Wi‑Fi bounce, optional Wake-on-LAN.

fn tcp_port_open(ip: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addr) = format!("{ip}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn tv_ssh_reachable(ip: &str, port: u16) -> bool {
    if ip.trim().is_empty() {
        return false;
    }
    // ICMP is often blocked; SSH open is what this app needs.
    tcp_port_open(ip.trim(), if port == 0 { 22 } else { port }, Duration::from_secs(3))
}

/// Discover LG TV IPv4 via mDNS (`lgwebostv.local`) — handles DHCP moves.
#[cfg(target_os = "macos")]
fn discover_lg_tv_ip() -> Option<String> {
    // 1) Directory-service cache
    if let Ok(out) = Command::new("dscacheutil")
        .args(["-q", "host", "-a", "name", "lgwebostv.local"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(rest) = line.trim().strip_prefix("ip_address:") {
                let ip = rest.trim();
                if ip.parse::<std::net::Ipv4Addr>().is_ok() {
                    return Some(ip.to_string());
                }
            }
        }
    }
    // 2) ping resolves mDNS even when host ignores ICMP
    if let Ok(out) = Command::new("ping")
        .args(["-c", "1", "-t", "1", "lgwebostv.local"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(start) = text.find('(') {
            if let Some(end) = text[start + 1..].find(')') {
                let ip = &text[start + 1..start + 1 + end];
                if ip.parse::<std::net::Ipv4Addr>().is_ok() {
                    return Some(ip.to_string());
                }
            }
        }
    }
    // 3) dns-sd browse briefly for AirPlay [LG] devices
    if let Ok(out) = Command::new("bash")
        .args([
            "-c",
            r#"script -q /dev/null bash -c 'dns-sd -B _airplay._tcp local. & p=$!; sleep 2; kill $p 2>/dev/null' 2>/dev/null | tr -d '\r' | sed -n 's/.*_airplay\._tcp\.[[:space:]]*\(\[LG\].*\)$/\1/p' | head -1"#,
        ])
        .output()
    {
        let inst = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !inst.is_empty() {
            let cmd = format!(
                r#"script -q /dev/null bash -c 'dns-sd -L "{inst}" _airplay._tcp local. & p=$!; sleep 2; kill $p 2>/dev/null' 2>/dev/null | tr -d '\r' | sed -n 's/.*can be reached at \([A-Za-z0-9.-]*\.local\)\.\?:.*/\1/p' | head -1"#
            );
            if let Ok(out2) = Command::new("bash").args(["-c", &cmd]).output() {
                let host = String::from_utf8_lossy(&out2.stdout).trim().to_string();
                if !host.is_empty() {
                    if let Ok(out3) = Command::new("dscacheutil")
                        .args(["-q", "host", "-a", "name", &host])
                        .output()
                    {
                        let text = String::from_utf8_lossy(&out3.stdout);
                        for line in text.lines() {
                            if let Some(rest) = line.trim().strip_prefix("ip_address:") {
                                let ip = rest.trim();
                                if ip.parse::<std::net::Ipv4Addr>().is_ok() {
                                    return Some(ip.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn discover_lg_tv_ip() -> Option<String> {
    None
}

/// Local Mac IPv4 (en0/en1) for subnet scanning.
#[cfg(target_os = "macos")]
fn local_ipv4() -> Option<std::net::Ipv4Addr> {
    for iface in ["en0", "en1", "en2"] {
        if let Ok(out) = Command::new("ipconfig").args(["getifaddr", iface]).output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(ip) = s.parse::<std::net::Ipv4Addr>() {
                return Some(ip);
            }
        }
    }
    None
}

/// Scan the Mac's /24 for hosts with SSH open (common when DHCP moved the TV).
#[cfg(target_os = "macos")]
fn scan_subnet_for_ssh(port: u16, prefer: Option<&str>) -> Option<String> {
    let local = local_ipv4()?;
    let octets = local.octets();
    let prefix = format!("{}.{}.{}", octets[0], octets[1], octets[2]);
    let port = if port == 0 { 22 } else { port };

    // Prefer configured IP first if different from self
    if let Some(p) = prefer {
        if p.parse::<std::net::Ipv4Addr>().is_ok() && p != local.to_string() && tv_ssh_reachable(p, port)
        {
            return Some(p.to_string());
        }
    }

    use std::sync::{Arc, Mutex};
    use std::thread;

    let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut handles = Vec::new();
    // Common TV DHCP range + full last-octet sweep in parallel batches
    for last in 1u8..=254 {
        if last == octets[3] {
            continue;
        }
        let ip = format!("{prefix}.{last}");
        let found_h = Arc::clone(&found);
        handles.push(thread::spawn(move || {
            if found_h.lock().map(|g| g.is_some()).unwrap_or(true) {
                return;
            }
            if tv_ssh_reachable(&ip, port) {
                if let Ok(mut g) = found_h.lock() {
                    if g.is_none() {
                        *g = Some(ip);
                    }
                }
            }
        }));
        // Limit concurrency a bit
        if handles.len() >= 64 {
            for h in handles.drain(..) {
                let _ = h.join();
            }
            if found.lock().map(|g| g.is_some()).unwrap_or(false) {
                break;
            }
        }
    }
    for h in handles {
        let _ = h.join();
    }
    found.lock().ok().and_then(|g| g.clone())
}

#[cfg(not(target_os = "macos"))]
fn scan_subnet_for_ssh(_port: u16, _prefer: Option<&str>) -> Option<String> {
    None
}

/// Flush stale ARP / REJECT host route.
/// `use_admin`: show macOS password dialog (can hang if dialog is missed).
#[cfg(target_os = "macos")]
fn flush_tv_neighbor(ip: &str, use_admin: bool) -> Result<(), String> {
    if ip.parse::<std::net::Ipv4Addr>().is_err() {
        return Err(format!("invalid IP: {ip}"));
    }
    // Non-root attempt first (works after Wi‑Fi bounce; often fails without sudo)
    let _ = Command::new("/usr/sbin/arp").args(["-d", ip]).output();
    let _ = Command::new("/sbin/route")
        .args(["-n", "delete", "-host", ip])
        .output();
    let _ = Command::new("/sbin/route")
        .args(["-n", "delete", ip])
        .output();

    if !use_admin {
        return Ok(());
    }

    // Admin flush (Prime Remote style) — only when explicitly requested
    let inner = format!(
        "/usr/sbin/arp -d {ip} 2>/dev/null; /sbin/route -n delete -host {ip} 2>/dev/null; /sbin/route -n delete {ip} 2>/dev/null; exit 0"
    );
    let script = format!("do shell script \"{inner}\" with administrator privileges");
    let out = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "authorization cancelled or failed".into()
        } else {
            err
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn flush_tv_neighbor(_ip: &str, _use_admin: bool) -> Result<(), String> {
    Err("neighbor flush is only supported on macOS".into())
}

fn parse_mac(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = mac.split(|c| c == ':' || c == '-').collect();
    if parts.len() != 6 {
        return None;
    }
    let mut bytes = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        bytes[i] = u8::from_str_radix(p.trim(), 16).ok()?;
    }
    Some(bytes)
}

fn send_wake_on_lan(mac: &str) -> Result<(), String> {
    let bytes = parse_mac(mac).ok_or_else(|| format!("Invalid MAC: {mac}"))?;
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&bytes);
    }
    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("WoL bind failed: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("WoL broadcast failed: {e}"))?;
    let mut sent = false;
    for port in [9u16, 7] {
        if socket
            .send_to(&packet, (std::net::Ipv4Addr::BROADCAST, port))
            .is_ok()
        {
            sent = true;
        }
    }
    if sent {
        Ok(())
    } else {
        Err("Could not send Wake-on-LAN packet".into())
    }
}

#[cfg(target_os = "macos")]
fn wifi_interface() -> String {
    if let Ok(out) = Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut wifi = false;
        for line in text.lines() {
            if line.contains("Wi-Fi") || line.contains("AirPort") {
                wifi = true;
            } else if wifi {
                if let Some(dev) = line.trim().strip_prefix("Device:") {
                    return dev.trim().to_string();
                }
            }
        }
    }
    "en0".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TvNetworkRepairReport {
    pub reachable: bool,
    pub ip: String,
    pub port: u16,
    pub ip_changed: bool,
    pub discovered: bool,
    pub wifi_restarted: bool,
    pub neighbor_flushed: bool,
    pub wol_sent: bool,
    pub steps: Vec<String>,
    pub advice: Option<String>,
}

/// Quick check: can we open SSH on the saved host? (loads settings from disk)
#[tauri::command]
async fn check_tv_reachable(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = load_settings_file(&app);
        let ip = s.host.trim().to_string();
        let port = if s.port == 0 { 22 } else { s.port };
        Ok(tv_ssh_reachable(&ip, port))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Find LG TV via mDNS and return its IPv4 (does not save).
#[tauri::command]
async fn discover_tv_ip() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        discover_lg_tv_ip().ok_or_else(|| {
            "No LG TV found via mDNS (lgwebostv.local). Is the TV on the same Wi‑Fi?".into()
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// Repair Mac↔TV unicast path when SSH times out / "no route to host".
/// Loads host/port from saved settings (like Prime Remote). Progress events:
/// `network-repair-progress`.
///
/// `restart_wifi` — bounce Mac Wi‑Fi (disruptive).
/// `use_admin` — show password dialog to flush ARP (can appear behind the app).
#[tauri::command]
async fn repair_tv_network(
    app: AppHandle,
    restart_wifi: bool,
    send_wol: bool,
    use_admin: bool,
    tv_mac: Option<String>,
) -> Result<TvNetworkRepairReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings_file(&app);
        repair_tv_network_sync(app, settings, restart_wifi, send_wol, use_admin, tv_mac)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

fn repair_tv_network_sync(
    app: AppHandle,
    mut settings: ConnectionSettings,
    restart_wifi: bool,
    send_wol: bool,
    use_admin: bool,
    tv_mac: Option<String>,
) -> Result<TvNetworkRepairReport, String> {
    let mut steps: Vec<String> = Vec::new();
    let emit = |msg: &str| {
        let _ = app.emit("network-repair-progress", format!("{msg}\n"));
    };
    let mut note = |s: String| {
        emit(&s);
        steps.push(s);
    };

    let port = if settings.port == 0 { 22 } else { settings.port };
    let mut ip = settings.host.trim().to_string();
    let mut ip_changed = false;
    let mut discovered = false;
    let mut neighbor_flushed = false;
    let mut wol_sent = false;
    let mut wifi_restarted = false;

    let done_ok = |ip: String,
                   port: u16,
                   ip_changed: bool,
                   discovered: bool,
                   wifi_restarted: bool,
                   neighbor_flushed: bool,
                   wol_sent: bool,
                   steps: Vec<String>| {
        TvNetworkRepairReport {
            reachable: true,
            ip,
            port,
            ip_changed,
            discovered,
            wifi_restarted,
            neighbor_flushed,
            wol_sent,
            steps,
            advice: None,
        }
    };

    note(format!(
        "Checking configured TV address ({}:{port})…",
        if ip.is_empty() { "<none>" } else { &ip }
    ));

    if !ip.is_empty() && tv_ssh_reachable(&ip, port) {
        note("SSH is already reachable. No repair needed.".into());
        return Ok(done_ok(
            ip,
            port,
            false,
            false,
            false,
            false,
            false,
            steps,
        ));
    }

    // 1) mDNS rediscover
    note("Looking for the LG TV on the network (mDNS)…".into());
    if let Some(found) = discover_lg_tv_ip() {
        discovered = true;
        if ip.is_empty() || found != ip {
            if !ip.is_empty() {
                note(format!(
                    "TV moved to a new address: {found} (was {ip}). Updating settings."
                ));
            } else {
                note(format!("Found TV at {found}. Updating settings."));
            }
            settings.host = found.clone();
            let _ = save_settings_file(&app, &settings);
            ip = found;
            ip_changed = true;
        } else {
            note(format!("TV is visible via mDNS at {ip}."));
        }
        if tv_ssh_reachable(&ip, port) {
            note(format!("SSH is now reachable at {ip}:{port}."));
            return Ok(done_ok(
                ip,
                port,
                ip_changed,
                discovered,
                false,
                false,
                false,
                steps,
            ));
        }
        note(
            "TV is visible via mDNS but not answering SSH (Wi‑Fi isolation or stale ARP)."
                .into(),
        );
    } else {
        note(
            "TV not found via mDNS (lgwebostv.local). Scanning LAN for SSH…"
                .into(),
        );
    }

    // 1b) Subnet scan for open SSH — finds TV after DHCP move even without mDNS
    note(format!("Scanning local network for open SSH port {port}…"));
    if let Some(found) = scan_subnet_for_ssh(port, Some(&ip)) {
        discovered = true;
        if found != ip {
            note(format!(
                "Found SSH at {found} (configured was {}). Updating settings.",
                if ip.is_empty() { "<none>" } else { &ip }
            ));
            settings.host = found.clone();
            let _ = save_settings_file(&app, &settings);
            ip = found;
            ip_changed = true;
        } else {
            note(format!("SSH answers at configured address {ip}."));
        }
        if tv_ssh_reachable(&ip, port) {
            note(format!("SSH is now reachable at {ip}:{port}."));
            return Ok(done_ok(
                ip,
                port,
                ip_changed,
                discovered,
                false,
                false,
                false,
                steps,
            ));
        }
    } else {
        note("No host on this LAN is accepting SSH right now.".into());
    }

    // 2) Flush stale ARP / host route (no password unless use_admin)
    if !ip.is_empty() {
        if use_admin {
            note(
                "Clearing stale ARP with admin privileges (password dialog — check Dock/other displays)…"
                    .into(),
            );
        } else {
            note("Clearing stale ARP entry (no password)…".into());
        }
        match flush_tv_neighbor(&ip, use_admin) {
            Ok(()) => {
                neighbor_flushed = true;
                note("ARP/route clear attempted. Probing again…".into());
                for _ in 0..4 {
                    let _ = Command::new("ping")
                        .args(["-c", "1", "-t", "1", &ip])
                        .output();
                }
                if tv_ssh_reachable(&ip, port) {
                    note(format!("SSH is now reachable at {ip}:{port}."));
                    return Ok(done_ok(
                        ip,
                        port,
                        ip_changed,
                        discovered,
                        false,
                        neighbor_flushed,
                        false,
                        steps,
                    ));
                }
                if let Some(found) = scan_subnet_for_ssh(port, None) {
                    if found != ip {
                        note(format!("After ARP flush, SSH found at {found}. Updating."));
                        settings.host = found.clone();
                        let _ = save_settings_file(&app, &settings);
                        ip = found;
                        ip_changed = true;
                        if tv_ssh_reachable(&ip, port) {
                            note(format!("SSH is now reachable at {ip}:{port}."));
                            return Ok(done_ok(
                                ip,
                                port,
                                ip_changed,
                                true,
                                false,
                                neighbor_flushed,
                                false,
                                steps,
                            ));
                        }
                    }
                }
            }
            Err(e) => note(format!(
                "Could not fully clear route ({e}). Continuing…"
            )),
        }
    }

    // 3) Optional Wake-on-LAN
    let mac = tv_mac
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    if !send_wol {
        note("Skipping Wake-on-LAN (not requested).".into());
    } else if mac.is_empty() {
        note("No TV MAC provided — skipping Wake-on-LAN.".into());
    } else {
        match send_wake_on_lan(mac) {
            Ok(()) => {
                wol_sent = true;
                note(format!("Sent Wake-on-LAN to {mac}. Waiting…"));
                std::thread::sleep(Duration::from_secs(4));
            }
            Err(e) => note(format!("Wake-on-LAN failed: {e}")),
        }
    }

    // 4) Optional Wi‑Fi bounce
    #[cfg(target_os = "macos")]
    if restart_wifi {
        let iface = wifi_interface();
        note(format!(
            "Restarting Mac Wi‑Fi ({iface}) — connection will drop for a few seconds…"
        ));
        let off = Command::new("networksetup")
            .args(["-setairportpower", &iface, "off"])
            .output();
        if let Ok(o) = &off {
            if !o.status.success() {
                note(format!(
                    "Wi‑Fi off warning: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ));
            }
        }
        std::thread::sleep(Duration::from_secs(3));
        let on = Command::new("networksetup")
            .args(["-setairportpower", &iface, "on"])
            .output();
        if let Ok(o) = &on {
            if !o.status.success() {
                note(format!(
                    "Wi‑Fi on failed: {} — turn Wi‑Fi back on manually if needed",
                    String::from_utf8_lossy(&o.stderr).trim()
                ));
            }
        }
        note("Waiting for Wi‑Fi to come back…".into());
        for i in 0..18 {
            std::thread::sleep(Duration::from_secs(1));
            if i == 5 || i == 10 || i == 15 {
                note(format!("  …still waiting ({i}s)"));
            }
            if !ip.is_empty() && tv_ssh_reachable(&ip, port) {
                break;
            }
        }
        wifi_restarted = true;
        note("Wi‑Fi cycle finished.".into());

        if let Some(found) = discover_lg_tv_ip() {
            if !found.is_empty() && found != ip {
                note(format!("TV re-appeared at {found}. Updating settings."));
                settings.host = found.clone();
                let _ = save_settings_file(&app, &settings);
                ip = found;
                ip_changed = true;
                discovered = true;
            }
        }
        if let Some(found) = scan_subnet_for_ssh(port, Some(&ip)) {
            if found != ip {
                note(format!("SSH found at {found} after Wi‑Fi reset. Updating."));
                settings.host = found.clone();
                let _ = save_settings_file(&app, &settings);
                ip = found;
                ip_changed = true;
                discovered = true;
            }
        }
    }

    let reachable = !ip.is_empty() && tv_ssh_reachable(&ip, port);
    let advice = if reachable {
        note(format!("SSH is now reachable at {ip}:{port}."));
        None
    } else {
        note("Still unable to reach the TV over SSH.".into());
        Some(
            "TV is still unreachable from this Mac. Check: (1) TV fully powered on, (2) same Wi‑Fi as Mac (not guest), (3) Developer Mode / SSH enabled on webOS, (4) IP in Settings matches TV Network settings. Wiring the TV via Ethernet often fixes Wi‑Fi isolation."
                .into(),
        )
    };

    Ok(TvNetworkRepairReport {
        reachable,
        ip,
        port,
        ip_changed,
        discovered,
        wifi_restarted,
        neighbor_flushed,
        wol_sent,
        steps,
        advice,
    })
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

/// Auto-configure RetroArch for Bluetooth/USB gamepads on webOS (sdl2 + autoconfig + profiles).
#[tauri::command]
async fn ra_setup_controller(
    settings: ConnectionSettings,
    refresh: Option<bool>,
) -> Result<String, String> {
    let mut args = vec!["setup-controller".into()];
    if refresh.unwrap_or(false) {
        args.push("--refresh".into());
    }
    // Profiles download can be slow; normal path is quick when profiles already exist.
    // Cap so a wedged SSH never leaves the Settings chip stuck red forever.
    run_control_async_timeout(settings, args, Duration::from_secs(90)).await
}

/// Start pad→mouse mapper on the TV.
/// `button`: l3|r3|select|start|l1|r1|l2|r2
/// `action`: lmb|rmb|mmb (default lmb)
#[tauri::command]
async fn ra_pad_mouse_start(
    settings: ConnectionSettings,
    button: String,
    action: Option<String>,
) -> Result<String, String> {
    let b = button.trim().to_ascii_lowercase();
    if b.is_empty() {
        return Err("button required (e.g. l3)".into());
    }
    let a = action
        .as_deref()
        .unwrap_or("lmb")
        .trim()
        .to_ascii_lowercase();
    let a = if a.is_empty() { "lmb".into() } else { a };
    // nowait: do not block the Mac UI for up to ~12s waiting on a gamepad
    run_control_async(
        settings,
        vec!["pad-mouse-start".into(), b, a, "nowait".into()],
    )
    .await
}

#[tauri::command]
async fn ra_pad_mouse_stop(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["pad-mouse-stop".into()]).await
}

#[tauri::command]
async fn ra_pad_mouse_status(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["pad-mouse-status".into()]).await
}

/// List gamepad-like input devices currently visible on the TV.
#[tauri::command]
async fn ra_list_gamepads(settings: ConnectionSettings) -> Result<String, String> {
    // Hard cap — top-right badge must stay snappy if SSH/luna stalls.
    run_control_async_timeout(
        settings,
        vec!["list-gamepads".into()],
        Duration::from_secs(10),
    )
    .await
}

/// Reconnect a previously paired Bluetooth HID gamepad on the TV (luna hid/connect).
#[tauri::command]
async fn ra_reconnect_gamepad(settings: ConnectionSettings) -> Result<String, String> {
    // One kick + short luna calls; kill if TV bluetooth2 stalls.
    run_control_async_timeout(
        settings,
        vec!["reconnect-gamepad".into()],
        Duration::from_secs(16),
    )
    .await
}

/// Amiga title-screen helper: inject pad Fire + Space/Enter + LMB on the TV.
#[tauri::command]
async fn ra_amiga_fire(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async_timeout(settings, vec!["amiga-fire".into()], Duration::from_secs(12)).await
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
    // Machine format: idx|name|path — stable for the GUI (no log noise on stdout).
    run_control_async_timeout(
        settings,
        vec!["adfs-machine".into()],
        Duration::from_secs(20),
    )
    .await
}

/// All games/demos/media under disks/* — system|idx|name|path
#[tauri::command]
async fn ra_list_media(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async_timeout(
        settings,
        vec!["media-machine".into()],
        Duration::from_secs(25),
    )
    .await
}

#[tauri::command]
async fn ra_list_cores(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["cores".into()]).await
}

/// Installed cores as machine lines: id|file|label|path
#[tauri::command]
async fn ra_list_cores_machine(settings: ConnectionSettings) -> Result<String, String> {
    // Short listing — hard cap so a stuck ControlMaster never freezes Engines on TV
    run_control_async_timeout(
        settings,
        vec!["cores-machine".into()],
        Duration::from_secs(20),
    )
    .await
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

/// List Kickstart BIOS files present on the TV system directory.
/// Machine lines: name|size  (one per file). Empty stdout = none found.
#[tauri::command]
async fn amiga_list_kickstarts(settings: ConnectionSettings) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || list_kickstarts_on_tv(&settings))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

fn list_kickstarts_on_tv(settings: &ConnectionSettings) -> Result<String, String> {
    let (key, user, host) = ssh_client_opts(settings)?;
    let system = settings.system_dir.trim();
    if system.is_empty() {
        return Err("Kickstart / system directory is not set (open Settings)".into());
    }
    let target = format!("{user}@{host}");
    // BusyBox-safe: find kick* / *.rom under system dir; emit name|bytes
    let remote = format!(
        "SYS={sys}; \
if [ ! -d \"$SYS\" ]; then echo DIR_MISSING; exit 0; fi; \
find \"$SYS\" -maxdepth 1 -type f \\( -iname 'kick*' -o -iname '*.rom' \\) 2>/dev/null | sort | while read -r p; do \
  b=$(basename \"$p\"); \
  sz=$(wc -c < \"$p\" 2>/dev/null | tr -d ' '); \
  printf '%s|%s\\n' \"$b\" \"${{sz:-0}}\"; \
done",
        sys = shell_single_quote(system)
    );

    let mut cmd = Command::new("ssh");
    apply_ssh_common(&mut cmd, settings, &key);
    cmd.arg("-p")
        .arg(settings.port.to_string())
        .arg(&target)
        .arg(&remote);

    let output = cmd
        .output()
        .map_err(|e| format!("ssh failed to start: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stdout.lines().any(|l| l.trim() == "DIR_MISSING") {
        return Err(format!(
            "system directory missing on TV:\n{system}\n\nCreate it or fix Settings → Kickstart / system directory"
        ));
    }
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(format!(
            "failed to list Kickstarts on TV:\n{}{}",
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\n{stdout}")
            }
        ));
    }
    Ok(stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.contains('|') && !l.contains("DIR_MISSING"))
        .collect::<Vec<_>>()
        .join("\n"))
}

#[tauri::command]
async fn ra_list_roms(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async(settings, vec!["roms".into()]).await
}

/// Basenames of content already on the TV for a system (amiga/snes/nes/…).
#[tauri::command]
async fn ra_list_installed(
    settings: ConnectionSettings,
    system: String,
) -> Result<String, String> {
    let sys = system.trim().to_ascii_lowercase();
    let sys = if sys.is_empty() {
        "amiga".into()
    } else {
        sys
    };
    run_control_async(settings, vec!["list-installed".into(), sys]).await
}

#[tauri::command]
async fn ra_play(settings: ConnectionSettings, pick: String) -> Result<String, String> {
    if pick.trim().is_empty() {
        return Err("pick a disk number or name".into());
    }
    run_control_async(settings, vec!["play".into(), pick.trim().into()]).await
}

/// Launch content for any system (amiga, snes, nes, genesis, gba, gbc, n64, psx, neogeo).
/// Uses control-retroarch.sh `play-media <system> <N|name>`.
#[tauri::command]
async fn ra_play_media(
    settings: ConnectionSettings,
    system: String,
    pick: String,
) -> Result<String, String> {
    let sys = system.trim().to_ascii_lowercase();
    let pick = pick.trim();
    if sys.is_empty() {
        return Err("system required (e.g. snes, amiga)".into());
    }
    if pick.is_empty() {
        return Err("pick a media number or name".into());
    }
    let sys = match sys.as_str() {
        "megadrive" | "md" => "genesis".into(),
        "ps1" => "psx".into(),
        "neo-geo" | "neo_geo" | "ng" => "neogeo".into(),
        other => other.into(),
    };
    run_control_async(
        settings,
        vec!["play-media".into(), sys, pick.into()],
    )
    .await
}

#[tauri::command]
async fn ra_remove(settings: ConnectionSettings, pick: String) -> Result<String, String> {
    if pick.trim().is_empty() {
        return Err("pick a disk number or name to remove".into());
    }
    run_control_async(settings, vec!["remove".into(), pick.trim().into()]).await
}

/// Delete media for any system (amiga, snes, nes, …) via `remove-media <system> <N|name>`.
#[tauri::command]
async fn ra_remove_media(
    settings: ConnectionSettings,
    system: String,
    pick: String,
) -> Result<String, String> {
    let sys = system.trim().to_ascii_lowercase();
    let pick = pick.trim();
    if sys.is_empty() {
        return Err("system required (e.g. snes, amiga)".into());
    }
    if pick.is_empty() {
        return Err("pick a media number or name to remove".into());
    }
    let sys = match sys.as_str() {
        "megadrive" | "md" => "genesis".into(),
        "ps1" => "psx".into(),
        "neo-geo" | "neo_geo" | "ng" => "neogeo".into(),
        other => other.into(),
    };
    run_control_async(
        settings,
        vec!["remove-media".into(), sys, pick.into()],
    )
    .await
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

/// Install ADFs/ROMs from Archive.org file URLs already shown in the UI.
/// Avoids re-searching the catalog (broken on titles with `$` `[]` etc.).
/// `content_system`: amiga (default), snes, nes, genesis, gba, gbc, n64, psx, neogeo.
#[tauri::command]
async fn amiga_install_urls(
    settings: ConnectionSettings,
    items: Vec<AdfInstallItem>,
    content_system: Option<String>,
) -> Result<String, String> {
    if items.is_empty() {
        return Err("select at least one title to install".into());
    }
    let key = expand_path(&settings.ssh_key);
    if !key.is_file() {
        return Err(format!("SSH key not found: {}", key.display()));
    }
    let sys = content_system
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "amiga".into());
    let sys = match sys.as_str() {
        "snes" | "nes" | "genesis" | "megadrive" | "gba" | "gbc" | "gb" | "n64" | "psx"
        | "ps1" | "neogeo" | "neo-geo" | "neo_geo" | "ng" | "amiga" => {
            if sys == "megadrive" {
                "genesis".into()
            } else if sys == "gb" {
                "gbc".into()
            } else if sys == "ps1" {
                "psx".into()
            } else if sys == "neo-geo" || sys == "neo_geo" || sys == "ng" {
                "neogeo".into()
            } else {
                sys
            }
        }
        _ => "amiga".into(),
    };
    let mut args = vec![
        "--yes".into(),
        "--skip-kickstarts".into(),
        "--content-system".into(),
        sys.into(),
    ];
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
    if args.len() <= 4 {
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

/// Middle mouse (emulator extra — classic Amiga mice are L+R only).
#[tauri::command]
async fn ra_click_middle(
    settings: ConnectionSettings,
    times: Option<u32>,
) -> Result<String, String> {
    let n = times.unwrap_or(1).clamp(1, 50).to_string();
    run_control_async(settings, vec!["click".into(), "middle".into(), n]).await
}

/// Mouse move. `mode`: "game" (ClickableMouse only, no system cursor) or "pointer" (webOS UI).
#[tauri::command]
async fn ra_mouse_move(
    settings: ConnectionSettings,
    dx: i32,
    dy: i32,
    mode: Option<String>,
) -> Result<String, String> {
    let m = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("game");
    let mode = if matches!(m, "pointer" | "system" | "ui") {
        "pointer"
    } else {
        "game"
    };
    // Game path: direct SSH python (ControlMaster) — much lower latency than
    // spawning control-retroarch.sh for every pixel of movement.
    if mode == "game" {
        return tauri::async_runtime::spawn_blocking(move || {
            inject_mouse_move_fast(&settings, dx, dy)
        })
        .await
        .map_err(|e| format!("task join error: {e}"))?;
    }
    run_control_async(
        settings,
        vec![
            "mouse-move".into(),
            dx.to_string(),
            dy.to_string(),
            mode.into(),
        ],
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
    let k = key.trim().to_string();
    if k.is_empty() {
        return Err("key required".into());
    }
    let lower = k.to_ascii_lowercase();
    let name = match lower.as_str() {
        "esc" | "escape" => "esc".to_string(),
        "enter" | "return" | "ret" | "ok" => "enter".to_string(),
        _ => k,
    };
    // Fast path: direct SSH + compact python (no control-retroarch.sh)
    tauri::async_runtime::spawn_blocking(move || inject_key_fast(&settings, &name, false))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

/// Virtual keyboard key; optional shift for named keys.
#[tauri::command]
async fn ra_keyboard_key(
    settings: ConnectionSettings,
    key: String,
    shift: Option<bool>,
) -> Result<String, String> {
    let k = key.trim().to_string();
    if k.is_empty() {
        return Err("key required".into());
    }
    if k.len() > 32 {
        return Err("key name too long".into());
    }
    let sh = shift.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || inject_key_fast(&settings, &k, sh))
        .await
        .map_err(|e| format!("task join error: {e}"))?
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
    tauri::async_runtime::spawn_blocking(move || type_text_fast(&settings, &text))
        .await
        .map_err(|e| format!("task join error: {e}"))?
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

/// Disable LG webOS screensaver (saves previous state on TV for restore).
#[tauri::command]
async fn ra_screensaver_disable(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async_timeout(
        settings,
        vec!["screensaver-disable".into()],
        Duration::from_secs(15),
    )
    .await
}

/// Restore LG webOS screensaver to values saved by ra_screensaver_disable.
#[tauri::command]
async fn ra_screensaver_restore(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async_timeout(
        settings,
        vec!["screensaver-restore".into()],
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
async fn ra_screensaver_status(settings: ConnectionSettings) -> Result<String, String> {
    run_control_async_timeout(
        settings,
        vec!["screensaver-status".into()],
        Duration::from_secs(12),
    )
    .await
}

/// Best-effort restore on process exit (sync; uses saved settings file).
fn restore_screensaver_on_exit() {
    // Only if the UI marked that we disabled the TV screensaver this session.
    let flag = screensaver_session_flag_path();
    if !flag.is_file() {
        return;
    }
    let Ok(settings) = load_settings_from_disk() else {
        let _ = fs::remove_file(&flag);
        return;
    };
    let _ = run_control_timeout(
        &settings,
        &["screensaver-restore"],
        Duration::from_secs(12),
    );
    let _ = fs::remove_file(&flag);
}

fn screensaver_session_flag_path() -> PathBuf {
    if let Some(home) = dirs_next::home_dir() {
        let p = home
            .join("Library/Application Support/com.aicoder.retroarch-control");
        let _ = fs::create_dir_all(&p);
        return p.join("screensaver-disabled.flag");
    }
    PathBuf::from("/tmp/ra-screensaver-disabled.flag")
}

fn load_settings_from_disk() -> Result<ConnectionSettings, String> {
    let home = dirs_next::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let candidates = [
        home.join("Library/Application Support/com.aicoder.retroarch-control/settings.json"),
        home.join("Library/Application Support/retroarch-control/settings.json"),
    ];
    for path in candidates {
        if path.is_file() {
            let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            return serde_json::from_str(&raw).map_err(|e| e.to_string());
        }
    }
    Err("no settings file".into())
}

/// Mark that this app session disabled the TV screensaver (for Exit restore).
#[tauri::command]
fn mark_screensaver_disabled_session(active: bool) -> Result<(), String> {
    let path = screensaver_session_flag_path();
    if active {
        fs::write(&path, b"1").map_err(|e| e.to_string())?;
    } else {
        let _ = fs::remove_file(&path);
    }
    Ok(())
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
            check_tv_reachable,
            discover_tv_ip,
            repair_tv_network,
            path_exists,
            resolve_path,
            default_ssh_key_candidates,
            ra_status,
            ra_setup_controller,
            ra_pad_mouse_start,
            ra_pad_mouse_stop,
            ra_pad_mouse_status,
            ra_list_gamepads,
            ra_reconnect_gamepad,
            ra_amiga_fire,
            ra_launch,
            ra_close,
            ra_kill,
            ra_restart,
            ra_list_adfs,
            ra_list_media,
            ra_list_cores,
            ra_list_cores_machine,
            ra_list_available_cores,
            ra_install_core,
            amiga_install_kickstart,
            amiga_list_kickstarts,
            ra_list_roms,
            ra_list_installed,
            ra_play,
            ra_play_media,
            ra_remove,
            ra_remove_media,
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
            ra_click_middle,
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
            ra_screensaver_disable,
            ra_screensaver_restore,
            ra_screensaver_status,
            mark_screensaver_disabled_session,
            open_mouse_window,
            open_remote_window,
            open_keyboard_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Restore TV screensaver if we disabled it this session
            if let tauri::RunEvent::Exit = event {
                restore_screensaver_on_exit();
            }
        });
}
