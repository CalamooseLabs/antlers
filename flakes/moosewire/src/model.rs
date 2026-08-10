//! Shared value types and POSIX path/quoting helpers.
//!
//! moosewire drives the remote side entirely by shelling out to `ssh`/`scp`, so
//! every remote path is handed to a remote shell at some point. That makes
//! correct single-quoting non-optional — the fleet's NAS paths literally contain
//! spaces (e.g. `/mnt/Media Library`). `sh_quote` is the one chokepoint for that.

/// A directory entry, shared by the local and remote backends.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// Size in bytes (0 for directories / unknown).
    pub size: u64,
    /// Modification time as a unix epoch (seconds); 0 if unknown.
    pub mtime: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dir,
    File,
    Link,
    Other,
}

impl Kind {
    pub fn is_dir(self) -> bool {
        matches!(self, Kind::Dir)
    }
}

/// Which pane / backend an action targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Local,
    Remote,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Local => Side::Remote,
            Side::Remote => Side::Local,
        }
    }
}

/// Wrap `s` in single quotes for safe interpolation into a remote shell command.
/// `it's` becomes `'it'\''s'`.
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Join a POSIX directory and a child name into a normalized absolute-ish path.
/// Used for both local and remote sides (both are POSIX here).
pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The parent of a POSIX path (`/a/b` -> `/a`, `/a` -> `/`, `/` -> `/`).
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
        None => "/".to_string(),
    }
}

/// The final component of a POSIX path (`/a/b` -> `b`).
pub fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(idx) => trimmed[idx + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

/// Human-friendly byte size (e.g. `1.4K`, `3.0M`).
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "K", "M", "G", "T", "P"];
    if bytes < 1024 {
        return format!("{bytes}{}", UNITS[0]);
    }
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if size >= 10.0 {
        format!("{:.0}{}", size, UNITS[unit])
    } else {
        format!("{:.1}{}", size, UNITS[unit])
    }
}

/// A short relative modification age (`3d`, `2h`, `5m`, `now`). Empty when the
/// mtime is unknown. Relative avoids any calendar/timezone math.
pub fn human_time(mtime: i64) -> String {
    if mtime <= 0 {
        return String::new();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let delta = now - mtime;
    if delta < 0 {
        return "now".to_string();
    }
    const MIN: i64 = 60;
    const HOUR: i64 = 60 * MIN;
    const DAY: i64 = 24 * HOUR;
    const WEEK: i64 = 7 * DAY;
    const YEAR: i64 = 365 * DAY;
    if delta < MIN {
        "now".to_string()
    } else if delta < HOUR {
        format!("{}m", delta / MIN)
    } else if delta < DAY {
        format!("{}h", delta / HOUR)
    } else if delta < WEEK {
        format!("{}d", delta / DAY)
    } else if delta < YEAR {
        format!("{}w", delta / WEEK)
    } else {
        format!("{}y", delta / YEAR)
    }
}
