//! The ncdu-style disk-usage view.
//!
//! [`DiskView`] holds the current directory and its immediate children. Each
//! child's *full recursive* size ([`walk_size`]) is expensive, so a background
//! thread computes them and posts results over an mpsc channel the app drains in
//! `tick()`; a child renders "…" until its size lands, then the list re-sorts by
//! size descending. Computed sizes are memoised in a `HashMap` so navigating out
//! and back is instant. Nothing here deletes — a delete is expressed as a
//! `Step::RemovePaths` and run through the shared reclaim worker.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use crate::model::{basename, walk_size, Kind};

/// One immediate child of the current directory.
#[derive(Clone)]
pub struct Child {
    pub path: PathBuf,
    pub name: String,
    pub kind: Kind,
    /// Full recursive size once known; `None` while the worker is still on it.
    pub size: Option<u64>,
    /// Modification time (unix epoch seconds); 0 if unknown. Rendered as a
    /// relative age so "big and old" is easy to spot.
    pub mtime: i64,
}

/// A size result posted by the background sizing thread.
pub struct SizeMsg {
    pub path: PathBuf,
    pub size: u64,
    /// Generation this belongs to — a stale scan's late results are dropped.
    pub gen: u64,
}

/// The disk-scan state: where we are, what's under us, and the size cache.
pub struct DiskView {
    /// Root the scan was opened at — we never navigate above it.
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub children: Vec<Child>,
    pub cursor: usize,
    /// Memoised recursive sizes, keyed by absolute path.
    cache: HashMap<PathBuf, u64>,
    /// Receiver for the current cwd's sizing worker.
    rx: Option<Receiver<SizeMsg>>,
    /// Bumped on every rescan; late messages from an old generation are ignored.
    gen: u64,
}

impl DiskView {
    /// Open a scan rooted (and starting) at `root`.
    pub fn new(root: PathBuf) -> DiskView {
        let mut dv = DiskView {
            root: root.clone(),
            cwd: root,
            children: Vec::new(),
            cursor: 0,
            cache: HashMap::new(),
            rx: None,
            gen: 0,
        };
        dv.rescan();
        dv
    }

    /// Total known size of the children currently listed (unknowns count as 0).
    /// Sums per-child recursive sizes, so a file hardlinked across sibling
    /// subtrees is counted once per subtree — the header shows it with a "~".
    pub fn total(&self) -> u64 {
        self.children
            .iter()
            .filter_map(|c| c.size)
            .fold(0u64, |a, b| a.saturating_add(b))
    }

    /// (Re)list the cwd's immediate children and (re)start the sizing worker.
    /// Cached sizes are used immediately; anything uncached is left `None` and
    /// filled in by the worker.
    pub fn rescan(&mut self) {
        self.gen = self.gen.wrapping_add(1);
        let gen = self.gen;

        let mut children = Vec::new();
        let mut pending: Vec<PathBuf> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.cwd) {
            for entry in rd.flatten() {
                let path = entry.path();
                let (kind, mtime) = match std::fs::symlink_metadata(&path) {
                    Ok(m) => {
                        let ft = m.file_type();
                        let kind = if ft.is_symlink() {
                            Kind::Link
                        } else if m.is_dir() {
                            Kind::Dir
                        } else if m.is_file() {
                            Kind::File
                        } else {
                            Kind::Other
                        };
                        (kind, m.mtime())
                    }
                    Err(_) => (Kind::Other, 0),
                };
                let cached = self.cache.get(&path).copied();
                if cached.is_none() {
                    pending.push(path.clone());
                }
                children.push(Child {
                    name: basename(&path),
                    path,
                    kind,
                    size: cached,
                    mtime,
                });
            }
        }
        self.children = children;
        self.sort();
        self.cursor = 0;

        // Spawn a worker for the uncached children of this generation.
        if pending.is_empty() {
            self.rx = None;
        } else {
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                for path in pending {
                    let size = walk_size(&path);
                    // If the receiver is gone (navigated away) just stop.
                    if tx.send(SizeMsg { path, size, gen }).is_err() {
                        return;
                    }
                }
            });
            self.rx = Some(rx);
        }
    }

    /// Drain any size results, updating children + cache and re-sorting. Returns
    /// true if anything changed (so the app can note it needn't force a redraw).
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        let mut drained: Vec<SizeMsg> = Vec::new();
        if let Some(rx) = &self.rx {
            while let Ok(msg) = rx.try_recv() {
                drained.push(msg);
            }
        }
        for msg in drained {
            // Cache every result; only reflect ones for the live generation.
            self.cache.insert(msg.path.clone(), msg.size);
            if msg.gen == self.gen {
                if let Some(c) = self.children.iter_mut().find(|c| c.path == msg.path) {
                    c.size = Some(msg.size);
                    changed = true;
                }
            }
        }
        if changed {
            self.sort();
        }
        changed
    }

    /// Sort children by size descending (unknowns sort last), then by name so
    /// the order is stable while sizes are still landing.
    fn sort(&mut self) {
        // Keep the hovered path so the cursor follows the entry across re-sorts.
        let hovered = self.children.get(self.cursor).map(|c| c.path.clone());
        self.children.sort_by(|a, b| {
            let av = a.size.unwrap_or(0);
            let bv = b.size.unwrap_or(0);
            b.size
                .is_some()
                .cmp(&a.size.is_some())
                .then_with(|| bv.cmp(&av))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        if let Some(path) = hovered {
            if let Some(idx) = self.children.iter().position(|c| c.path == path) {
                self.cursor = idx;
            }
        }
    }

    pub fn hovered(&self) -> Option<&Child> {
        self.children.get(self.cursor)
    }

    pub fn move_cursor(&mut self, delta: isize) {
        if self.children.is_empty() {
            return;
        }
        let max = self.children.len() as isize - 1;
        self.cursor = (self.cursor as isize + delta).clamp(0, max) as usize;
    }

    pub fn cursor_to(&mut self, idx: usize) {
        self.cursor = idx.min(self.children.len().saturating_sub(1));
    }

    /// Enter the hovered directory (no-op on non-dirs / symlinks).
    pub fn enter(&mut self) {
        let Some(child) = self.hovered() else {
            return;
        };
        if child.kind.is_dir() {
            let path = child.path.clone();
            self.cwd = path;
            self.rescan();
        }
    }

    /// Go up one directory, but never above the scan root. Landing the cursor on
    /// the directory we came out of.
    pub fn up(&mut self) {
        if self.cwd == self.root {
            return; // pinned at the scan root
        }
        let Some(parent) = self.cwd.parent().map(Path::to_path_buf) else {
            return;
        };
        let leaving = self.cwd.clone();
        self.cwd = parent;
        self.rescan();
        if let Some(idx) = self.children.iter().position(|c| c.path == leaving) {
            self.cursor_to(idx);
        }
    }

    /// Forget the cached size for `path` (call after a delete so a rescan
    /// recomputes it rather than showing a stale value).
    pub fn invalidate(&mut self, path: &Path) {
        self.cache.remove(path);
    }
}
