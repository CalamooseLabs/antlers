//! Shared value types + size/path helpers for moosebroom.
//!
//! This is the frozen contract every other module builds on. In particular it
//! is the ONE place destructive work is described: a [`Target`] carries a list
//! of [`Step`]s, and [`Step`] is deliberately narrow — argv-only command runs
//! (no shell string ever built from a path) and `std::fs` removals that never
//! follow symlinks. `reclaim.rs` is the only executor of these steps.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A cleanup category — the top-level grouping in the reclaim view. The
/// disk-usage *scan* is a separate mode, not a category.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Nix,
    Caches,
    Dev,
}

impl Category {
    pub const ALL: [Category; 3] = [Category::Nix, Category::Caches, Category::Dev];

    /// Section header shown above the category's targets.
    pub fn title(self) -> &'static str {
        match self {
            Category::Nix => "NIX STORE & GENERATIONS",
            Category::Caches => "CACHES & JUNK",
            Category::Dev => "DEV / CONTAINER JUNK",
        }
    }
}

/// One reclaimable thing the user can mark and clean.
#[derive(Clone, Debug)]
pub struct Target {
    pub category: Category,
    /// Stable identifier, also the key used to track marks/selection.
    pub key: String,
    /// Short name shown in the list (e.g. "~/.cache").
    pub label: String,
    /// One-line human detail (a path, a count, "docker not found", …).
    pub detail: String,
    /// Estimated reclaimable bytes when cheaply known; `None` renders as "—"
    /// and the real freed amount is reported by the tool at run time.
    pub bytes: Option<u64>,
    /// Steps run in order to reclaim this target.
    pub steps: Vec<Step>,
    /// The steps need root; when euid != 0 the target is locked (can't be
    /// marked) and the UI hints to re-run under sudo.
    pub needs_root: bool,
}

impl Target {
    /// A target with nothing to reclaim (0 bytes / count) that stays visible so
    /// the user sees it was checked. Locked from marking.
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty() || self.bytes == Some(0)
    }
}

/// A single reclaim action. NEVER construct a shell command string from a path;
/// [`Step::Run`] passes argv straight to the program and the removal variants
/// use `std::fs` and never follow symlinks.
#[derive(Clone, Debug)]
pub enum Step {
    /// Run `program` with `args`, PATH-resolved, no shell. Its stdout/stderr
    /// tail is captured for the result line (used for nix-collect-garbage,
    /// nix-store --optimise, journalctl --vacuum-*, docker system prune, …).
    Run {
        program: String,
        args: Vec<String>,
    },
    /// Remove the *contents* of `dir` (each direct child, recursively) while
    /// keeping `dir` itself. Skipped entirely if `dir` is a symlink or missing.
    /// Used for cache directories we want to keep as empty dirs.
    ClearDir { dir: PathBuf },
    /// Remove each path outright — a file is unlinked, a directory tree is
    /// removed, a symlink is unlinked (never followed to its target).
    RemovePaths { paths: Vec<PathBuf> },
}

/// A filesystem entry kind, shared by the disk-usage scanner.
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

/// The effective uid, read from `/proc/self/status` (field 3 of the `Uid:`
/// line). Linux-only, which this crate already is. Falls back to a non-zero
/// sentinel so we never wrongly believe we are root.
pub fn euid() -> u32 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Uid:") {
            // real  effective  saved  fs
            if let Some(eff) = rest.split_whitespace().nth(1) {
                if let Ok(n) = eff.parse::<u32>() {
                    return n;
                }
            }
        }
    }
    u32::MAX
}

pub fn is_root() -> bool {
    euid() == 0
}

/// `$HOME` as a path, falling back to `/root` for root and `/` otherwise.
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(if is_root() { "/root" } else { "/" }))
}

/// `$XDG_CACHE_HOME`, else `~/.cache`.
pub fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home().join(".cache"))
}

/// Actual on-disk usage of `root` in bytes (`st_blocks * 512`), walking the
/// whole subtree. Never follows symlinks. Dedups hardlinks by (dev, inode) so
/// a file linked N times is counted once. Unreadable entries are skipped. A
/// single file returns its own block usage.
pub fn walk_size(root: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;

    let mut total: u64 = 0;
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(path) = stack.pop() {
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        // Count blocks once per unique inode (hardlink-safe).
        if meta.nlink() > 1 {
            if !seen.insert((meta.dev(), meta.ino())) {
                continue;
            }
        }
        total = total.saturating_add(meta.blocks().saturating_mul(512));
        // Descend only into real directories, never through symlinks.
        if meta.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&path) {
                for entry in rd.flatten() {
                    stack.push(entry.path());
                }
            }
        }
    }
    total
}

/// Human-friendly byte size (e.g. `1.4K`, `3.0G`). Binary units.
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

/// A short relative modification age (`3d`, `2h`, `now`). Empty if unknown.
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

/// The final component of a path as a lossy string (`/a/b` -> `b`, `/` -> `/`).
pub fn basename(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}
