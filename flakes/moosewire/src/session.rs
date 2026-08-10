//! The SSH ControlMaster session — the heart of moosewire.
//!
//! Opening a session starts ONE backgrounded master connection
//! (`ssh -f -N -M -S <sock> -o ControlPersist=…`). That single connection costs
//! one Yubikey touch (FIDO2 resident key, no agent on this fleet). Every
//! subsequent `ls`/`mkdir`/`mv`/`rm` and every `scp` reuses the socket with
//! `-S <sock>` / `-o ControlPath=<sock>` and needs no further touch.
//!
//! The remote side needs nothing but `sshd` + coreutils/findutils — no agent,
//! no sshfs, no moosewire binary. Directory listings come from GNU
//! `find -printf` (the fleet is all NixOS = GNU findutils).

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::config::Target;
use crate::model::{sh_quote, Entry, Kind};

pub struct Session {
    /// `user@addr` actually used (after DNS→IP fallback).
    spec: String,
    /// Human name (for pane headers).
    pub name: String,
    port: u16,
    sock: PathBuf,
    closed: bool,
}

impl Session {
    pub fn spec(&self) -> &str {
        &self.spec
    }

    pub fn control_path(&self) -> &PathBuf {
        &self.sock
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Pick the address to connect to: prefer the hostname, fall back to the
    /// baked IP if the hostname neither resolves nor accepts a TCP connection on
    /// the SSH port (the fleet's on-/off-LAN idiom). ~2s probe budget each.
    fn resolve_addr(target: &Target) -> String {
        if reachable(&target.host, target.port) {
            return target.host.clone();
        }
        if let Some(ip) = &target.fallback_ip {
            if reachable(ip, target.port) {
                return ip.clone();
            }
        }
        // Nothing probed clean; hand the hostname to ssh and let it error clearly.
        target.host.clone()
    }

    /// Start the background master. Blocks while the Yubikey is touched.
    pub fn open(target: &Target) -> Result<Session, String> {
        let addr = Self::resolve_addr(target);
        let spec = target.spec_for(&addr);
        let sock = socket_path(&spec)?;

        // Clean up any stale socket from a crashed run.
        let _ = std::fs::remove_file(&sock);

        eprintln!(
            "moosewire: connecting to {} ({}) — touch your Yubikey if it blinks…",
            target.name, addr
        );

        let status = Command::new("ssh")
            .args(["-f", "-N", "-M"])
            .arg("-S")
            .arg(&sock)
            .args(["-o", "ControlMaster=auto"])
            .args(["-o", "ControlPersist=300"])
            .args(["-o", "ConnectTimeout=10"])
            .args(["-o", "ServerAliveInterval=15"])
            .args(["-o", "ServerAliveCountMax=3"])
            .arg("-p")
            .arg(target.port.to_string())
            .arg(&spec)
            .status()
            .map_err(|e| format!("failed to launch ssh: {e}"))?;

        if !status.success() {
            return Err(format!("ssh master to {spec} failed (bad auth or host down)"));
        }

        let session = Session {
            spec,
            name: target.name.clone(),
            port: target.port,
            sock,
            closed: false,
        };

        // Confirm the master is actually alive.
        session.check()?;
        Ok(session)
    }

    fn check(&self) -> Result<(), String> {
        let out = Command::new("ssh")
            .arg("-S")
            .arg(&self.sock)
            .args(["-O", "check"])
            .arg(&self.spec)
            .output()
            .map_err(|e| format!("ssh check failed: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "control master not running: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    /// Run a fully-formed remote shell command over the master, returning stdout.
    /// `command` MUST already be shell-safe (quote paths with `sh_quote`).
    fn run(&self, command: &str) -> Result<String, String> {
        let out = Command::new("ssh")
            .arg("-S")
            .arg(&self.sock)
            .args(["-o", "ControlMaster=no"])
            .arg(&self.spec)
            .arg(command)
            .output()
            .map_err(|e| format!("ssh exec failed: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// The remote login home directory (used as the starting cwd).
    pub fn home(&self) -> String {
        self.run("printf %s \"$HOME\"")
            .map(|s| s.trim().to_string())
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/".to_string())
    }

    /// List a remote directory via `find -printf`.
    pub fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        // %y=type(one char) %s=size %T@=mtime-epoch %f=basename, tab separated.
        // `|| true` so a per-entry permission error inside the dir doesn't turn
        // the whole listing into an ssh non-zero exit; a dead master still
        // surfaces because ssh itself (not the remote command) fails then.
        let cmd = format!(
            "find {} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null || true",
            sh_quote(path)
        );
        let stdout = self.run(&cmd)?;
        let mut entries = Vec::new();
        for line in stdout.lines() {
            let mut cols = line.splitn(4, '\t');
            let (Some(ty), Some(size), Some(mtime), Some(name)) =
                (cols.next(), cols.next(), cols.next(), cols.next())
            else {
                continue;
            };
            let kind = match ty {
                "d" => Kind::Dir,
                "f" => Kind::File,
                "l" => Kind::Link,
                _ => Kind::Other,
            };
            entries.push(Entry {
                name: name.to_string(),
                kind,
                size: size.parse().unwrap_or(0),
                mtime: mtime.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0),
            });
        }
        Ok(entries)
    }

    /// Resolve whether a remote symlink points at a directory (for navigation).
    pub fn is_dir(&self, path: &str) -> bool {
        self.run(&format!("test -d {} && echo y", sh_quote(path)))
            .map(|s| s.trim() == "y")
            .unwrap_or(false)
    }

    pub fn mkdir(&self, path: &str) -> Result<(), String> {
        self.run(&format!("mkdir -p {}", sh_quote(path))).map(|_| ())
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.run(&format!("mv -n {} {}", sh_quote(from), sh_quote(to)))
            .map(|_| ())
    }

    pub fn delete(&self, path: &str) -> Result<(), String> {
        self.run(&format!("rm -rf {}", sh_quote(path))).map(|_| ())
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = Command::new("ssh")
            .arg("-S")
            .arg(&self.sock)
            .args(["-O", "exit"])
            .arg(&self.spec)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::fs::remove_file(&self.sock);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

/// TCP-probe `host:port` with a short timeout across all resolved addresses.
fn reachable(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(2000)).is_ok() {
            return true;
        }
    }
    false
}

/// A short, collision-resistant control-socket path under the runtime dir.
/// Kept short because AF_UNIX paths are capped near 104 bytes.
fn socket_path(spec: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = base.join("moosewire");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let key = fnv1a(spec);
    Ok(dir.join(format!("cm-{key:x}")))
}

/// Tiny non-cryptographic hash to name the socket deterministically per spec.
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
