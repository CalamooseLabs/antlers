//! Reclaim probing — the read-only pass that turns this host's state into a
//! stable list of [`Target`]s for the reclaim view.
//!
//! [`scan`] ALWAYS emits every target every run so the UI never reshuffles: a
//! target with nothing to reclaim (tool absent, dir empty, only the current
//! generation left) is still listed but rendered locked (`bytes: Some(0)`
//! and/or empty `steps`, see [`Target::is_empty`]). Root-only targets are
//! marked `needs_root` and the UI locks them until we run as root. Nothing here
//! deletes anything — the destructive `Step`s are merely *described* and only
//! `reclaim.rs` ever executes them.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::model::{cache_dir, home, walk_size, Category, Step, Target};

/// Probe this host and return every reclaim target, in a fixed order (Nix,
/// then caches, then dev/container junk). Runs a handful of cheap-ish commands
/// (`nix-store --gc --print-dead` can take a few seconds — that's why this runs
/// on a background thread at startup).
pub fn scan() -> Vec<Target> {
    let mut targets = Vec::new();
    nix_targets(&mut targets);
    cache_targets(&mut targets);
    dev_targets(&mut targets);
    targets
}

// ---- category builders -------------------------------------------------------

fn nix_targets(out: &mut Vec<Target>) {
    // 1. nix-collect-garbage -d — dead paths reported by a dry-run of the GC.
    let detail = match cmd_output("nix-store", &["--gc", "--print-dead"]) {
        Some(text) => {
            let dead = text.lines().filter(|l| !l.trim().is_empty()).count();
            format!("{dead} dead store paths")
        }
        None => "collect garbage + delete old user generations".to_string(),
    };
    out.push(Target {
        category: Category::Nix,
        key: "nix-gc".to_string(),
        label: "nix-collect-garbage -d".to_string(),
        detail,
        bytes: None,
        steps: vec![Step::Run {
            program: "nix-collect-garbage".to_string(),
            args: vec!["-d".to_string()],
        }],
        needs_root: false,
    });

    // 2. old system generations — everything but the "(current)" one.
    let old = system_old_gens();
    let (detail, steps) = if old > 0 {
        (
            format!("{old} old generations"),
            vec![Step::Run {
                program: "nix-env".to_string(),
                args: [
                    "-p",
                    "/nix/var/nix/profiles/system",
                    "--delete-generations",
                    "old",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            }],
        )
    } else {
        // Locked: nothing but the current generation.
        ("only current generation".to_string(), Vec::new())
    };
    out.push(Target {
        category: Category::Nix,
        key: "nix-system-gens".to_string(),
        label: "old system generations".to_string(),
        detail,
        bytes: None,
        steps,
        needs_root: true,
    });

    // 3. optimise store — dedup identical files into hardlinks. Always offered.
    out.push(Target {
        category: Category::Nix,
        key: "nix-optimise".to_string(),
        label: "optimise store (dedup)".to_string(),
        detail: "hardlink identical files".to_string(),
        bytes: None,
        steps: vec![Step::Run {
            program: "nix-store".to_string(),
            args: vec!["--optimise".to_string()],
        }],
        needs_root: false,
    });
}

fn cache_targets(out: &mut Vec<Target>) {
    // 4. ~/.cache — clear the contents, keep the dir shell. Guard against a
    //    misconfigured XDG_CACHE_HOME that would resolve to $HOME or / and turn
    //    "clear ~/.cache" into "empty the home directory".
    let cache = cache_dir();
    let (detail, bytes, steps) = if is_dangerous_root(&cache) {
        (
            format!("unsafe path {} — check XDG_CACHE_HOME", cache.display()),
            0,
            Vec::new(),
        )
    } else {
        (
            cache.display().to_string(),
            walk_size(&cache),
            vec![Step::ClearDir { dir: cache }],
        )
    };
    out.push(Target {
        category: Category::Caches,
        key: "cache-home".to_string(),
        label: "~/.cache".to_string(),
        detail,
        bytes: Some(bytes),
        steps,
        needs_root: false,
    });

    // 5. trash — ${XDG_DATA_HOME:-~/.local/share}/Trash, contents of files/+info/
    //    while keeping the Trash dir shell (per the freedesktop layout). Same
    //    XDG guard as ~/.cache.
    let trash = data_home().join("Trash");
    let (detail, bytes, steps) = if is_dangerous_root(&trash) {
        (
            format!("unsafe path {} — check XDG_DATA_HOME", trash.display()),
            0,
            Vec::new(),
        )
    } else {
        (
            trash.display().to_string(),
            walk_size(&trash),
            vec![
                Step::ClearDir {
                    dir: trash.join("files"),
                },
                Step::ClearDir {
                    dir: trash.join("info"),
                },
            ],
        )
    };
    out.push(Target {
        category: Category::Caches,
        key: "trash".to_string(),
        label: "trash".to_string(),
        detail,
        bytes: Some(bytes),
        steps,
        needs_root: false,
    });

    // 6. systemd journal — vacuum down to 200M. Size parsed from journalctl.
    let journal_bytes = journal_disk_usage();
    let detail = match journal_bytes {
        Some(b) => format!("{}, keeps 200M", crate::model::human_size(b)),
        None => "vacuum to 200M".to_string(),
    };
    out.push(Target {
        category: Category::Caches,
        key: "journal".to_string(),
        label: "systemd journal".to_string(),
        detail,
        bytes: journal_bytes,
        steps: vec![Step::Run {
            program: "journalctl".to_string(),
            args: vec!["--vacuum-size=200M".to_string()],
        }],
        needs_root: true,
    });

    // 7. coredumps — /var/lib/systemd/coredump, cleared.
    let coredump = PathBuf::from("/var/lib/systemd/coredump");
    let bytes = walk_size(&coredump);
    out.push(Target {
        category: Category::Caches,
        key: "coredumps".to_string(),
        label: "coredumps".to_string(),
        detail: coredump.display().to_string(),
        bytes: Some(bytes),
        steps: vec![Step::ClearDir { dir: coredump }],
        needs_root: true,
    });
}

fn dev_targets(out: &mut Vec<Target>) {
    // 8. docker — prune unused images/build cache/stopped containers. NEVER
    //    --volumes (that would delete data). Locked when docker isn't on PATH.
    out.push(container_target(
        "docker",
        "docker system prune -af",
        "docker",
    ));
    // 9. podman — same shape.
    out.push(container_target(
        "podman",
        "podman system prune -af",
        "podman",
    ));

    // 10. ~/.cargo cache — registry cache/src + git checkouts (never bin,
    //     never registry/index).
    let cargo = home().join(".cargo");
    let (detail, bytes, steps) = if cargo.is_dir() {
        let candidates = [
            cargo.join("registry/cache"),
            cargo.join("registry/src"),
            cargo.join("git/checkouts"),
        ];
        let paths: Vec<PathBuf> = candidates.into_iter().filter(|p| p.exists()).collect();
        let total: u64 = paths.iter().map(|p| walk_size(p)).sum();
        if paths.is_empty() {
            ("empty".to_string(), 0, Vec::new())
        } else {
            (
                cargo.display().to_string(),
                total,
                vec![Step::RemovePaths { paths }],
            )
        }
    } else {
        // Locked: no ~/.cargo at all.
        ("not present".to_string(), 0, Vec::new())
    };
    out.push(Target {
        category: Category::Dev,
        key: "cargo".to_string(),
        label: "~/.cargo cache".to_string(),
        detail,
        bytes: Some(bytes),
        steps,
        needs_root: false,
    });

    // 11. ~/.npm cache — the _cacache tree.
    let npm = home().join(".npm/_cacache");
    let bytes = walk_size(&npm);
    let detail = if npm.is_dir() {
        npm.display().to_string()
    } else {
        "not present".to_string()
    };
    out.push(Target {
        category: Category::Dev,
        key: "npm".to_string(),
        label: "~/.npm cache".to_string(),
        detail,
        bytes: Some(bytes),
        steps: vec![Step::ClearDir { dir: npm }],
        needs_root: false,
    });
}

/// Build a container-runtime prune target for `bin` (docker/podman). Locked with
/// a "not installed" detail when the runtime isn't on PATH.
fn container_target(bin: &str, label: &str, key: &str) -> Target {
    if have(bin) {
        Target {
            category: Category::Dev,
            key: key.to_string(),
            label: label.to_string(),
            detail: "unused images, build cache, stopped containers".to_string(),
            bytes: None,
            steps: vec![Step::Run {
                program: bin.to_string(),
                // NOTE: no --volumes — we never delete container volumes.
                args: ["system", "prune", "-af"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            }],
            needs_root: false,
        }
    } else {
        Target {
            category: Category::Dev,
            key: key.to_string(),
            label: label.to_string(),
            detail: "not installed".to_string(),
            bytes: Some(0),
            steps: Vec::new(),
            needs_root: false,
        }
    }
}

// ---- probes ------------------------------------------------------------------

/// Count non-current system generations: total `--list-generations` lines minus
/// the single one flagged "(current)". Zero (locked) if the command fails.
fn system_old_gens() -> usize {
    let Some(text) = cmd_output(
        "nix-env",
        &["-p", "/nix/var/nix/profiles/system", "--list-generations"],
    ) else {
        return 0;
    };
    let total = text.lines().filter(|l| !l.trim().is_empty()).count();
    let current = text.lines().filter(|l| l.contains("(current)")).count();
    total.saturating_sub(current)
}

/// The systemd journal's on-disk size, parsed from `journalctl --disk-usage`
/// ("Archived and active journals take up NNN.N<unit> in the file system.").
fn journal_disk_usage() -> Option<u64> {
    let text = cmd_output("journalctl", &["--disk-usage"])?;
    // Grab the token before "in the file system", e.g. "1.2G" / "512.0M".
    let marker = "take up ";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let size = rest.split_whitespace().next()?;
    parse_human_size(size)
}

/// Parse a human size like "1.2G" / "512M" / "4.0K" / "900B" into bytes. Binary
/// units, matching how systemd/coreutils print them.
fn parse_human_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, unit) = match s.find(|c: char| c.is_ascii_alphabetic()) {
        Some(idx) => (&s[..idx], &s[idx..]),
        None => (s, ""),
    };
    let value: f64 = num.trim().parse().ok()?;
    let mult: f64 = match unit.trim().to_ascii_uppercase().as_str() {
        "" | "B" => 1.0,
        "K" | "KB" | "KIB" => 1024.0,
        "M" | "MB" | "MIB" => 1024.0 * 1024.0,
        "G" | "GB" | "GIB" => 1024.0f64.powi(3),
        "T" | "TB" | "TIB" => 1024.0f64.powi(4),
        "P" | "PB" | "PIB" => 1024.0f64.powi(5),
        _ => return None,
    };
    Some((value * mult) as u64)
}

/// True if a `$XDG_*`-derived clear target resolved to something we must never
/// wipe: `$HOME` itself, a filesystem root, or an empty path. A misconfigured
/// `XDG_CACHE_HOME=$HOME` must not turn "clear ~/.cache" into "empty $HOME".
fn is_dangerous_root(dir: &Path) -> bool {
    dir.as_os_str().is_empty() || dir.parent().is_none() || dir == home().as_path()
}

/// `${XDG_DATA_HOME:-~/.local/share}`.
fn data_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home().join(".local/share"))
}

// ---- process helpers ---------------------------------------------------------

/// Is an executable named `bin` on `$PATH`? Walks the colon-separated `$PATH`
/// and checks for a regular file with an execute bit set — a runtime "is this
/// tool here" test without shelling out.
pub fn have(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(bin);
        candidate
            .metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

/// Run `program args…` and return its trimmed stdout, or `None` if it can't be
/// launched or exits non-zero. No shell — argv only.
pub fn cmd_output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
