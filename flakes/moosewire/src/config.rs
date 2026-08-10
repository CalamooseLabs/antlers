//! Remote target definitions and the baked host list.
//!
//! The `/etc/nixos` module renders `$XDG_CONFIG_HOME/moosewire/hosts` from
//! `settings.nix` (`cala-m-os.ip.*`). Each non-comment line is whitespace
//! separated:
//!
//! ```text
//! # name        target            fallback-ip
//! homelab       hub@homelab       10.10.10.15
//! battlestation hub@battlestation 10.10.10.30
//! ```
//!
//! `target` is `[user@]host[:port]`; the optional third column is an IP used when
//! the hostname does not resolve / connect (the fleet's DNS-then-IP idiom).

use std::fs;

/// A resolved SSH destination.
#[derive(Clone, Debug)]
pub struct Target {
    /// Display name (menu label / pane header).
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    /// Fallback address if `host` doesn't resolve/connect.
    pub fallback_ip: Option<String>,
}

impl Target {
    /// `user@host`, the spec passed to ssh/scp.
    pub fn spec_for(&self, addr: &str) -> String {
        format!("{}@{}", self.user, addr)
    }
}

/// Parse a `[user@]host[:port]` spec into (user?, host, port?).
fn parse_spec(spec: &str) -> (Option<String>, String, Option<u16>) {
    let (user, rest) = match spec.split_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, spec),
    };
    let (host, port) = match rest.rsplit_once(':') {
        // Only treat the tail as a port if it's numeric (avoid eating IPv6 / paths).
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => {
            (h.to_string(), p.parse::<u16>().ok())
        }
        _ => (rest.to_string(), None),
    };
    (user, host, port)
}

/// Build a [`Target`] from a CLI argument that is either a bare host list name
/// or an inline `[user@]host[:port]` spec. `default_user` fills in a missing user.
pub fn target_from_arg(arg: &str, hosts: &[Target], default_user: &str) -> Target {
    if let Some(found) = hosts.iter().find(|t| t.name == arg) {
        return found.clone();
    }
    let (user, host, port) = parse_spec(arg);
    Target {
        name: host.clone(),
        user: user.unwrap_or_else(|| default_user.to_string()),
        host,
        port: port.unwrap_or(22),
        fallback_ip: None,
    }
}

/// Load the baked host list. Missing file => empty list (inline specs still work).
pub fn load_hosts(default_user: &str) -> Vec<Target> {
    let Some(path) = hosts_file_path() else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 {
            continue;
        }
        let name = cols[0].to_string();
        let (user, host, port) = parse_spec(cols[1]);
        out.push(Target {
            name,
            user: user.unwrap_or_else(|| default_user.to_string()),
            host,
            port: port.unwrap_or(22),
            fallback_ip: cols.get(2).map(|s| s.to_string()),
        });
    }
    out
}

fn hosts_file_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(base.join("moosewire").join("hosts"))
}

/// The default remote user: `$MOOSEWIRE_USER`, else `$USER`, else `hub`.
pub fn default_user() -> String {
    std::env::var("MOOSEWIRE_USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USER").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "hub".to_string())
}
