//! Background reclaim worker — the ONLY executor of [`Step`]s.
//!
//! Modeled on moosewire's `transfer.rs`: a [`Job`] of one-or-more items runs on
//! its own thread, posting progress over an mpsc channel the UI drains each
//! tick. The app blocks starting a second job while one runs (just as moosewire
//! blocks a second transfer).
//!
//! Safety is the whole point. A [`Step`] is never turned into a shell string:
//! [`Step::Run`] hands argv straight to the program, and the removal variants go
//! through `std::fs` and NEVER follow a symlink (a symlinked cache dir is
//! skipped; a symlink child is unlinked, never recursed into). There is no code
//! path here that deletes anything not derived from a `Step`.

use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::thread;

use std::os::unix::fs::MetadataExt;

use crate::model::{human_size, walk_size, Step};

/// One labeled unit of work: everything needed to reclaim a single target (or a
/// single disk-view delete).
pub struct Item {
    /// Human name shown in the gauge / report (e.g. "~/.cache").
    pub label: String,
    pub steps: Vec<Step>,
}

/// A batch of items to reclaim in order.
pub struct Job {
    pub items: Vec<Item>,
}

/// A progress message from the worker thread.
pub enum ReclaimMsg {
    /// Starting item `done`-of-`total`, named `name`.
    Current { done: usize, total: usize, name: String },
    /// A finished report line to append to the running log.
    Line(String),
    /// Cumulative freed-bytes estimate so far.
    Freed(u64),
    /// A `Step::Run` was executed (tools report their own freed space to the
    /// log, not to `freed`, so this lets the UI avoid claiming "freed ~0B").
    Ran,
    /// The batch is complete.
    Finished,
}

/// Live handle the UI polls each tick. Fields mirror moosewire's `Transfer`
/// (verb + current + done/total) plus a growing report and freed-byte counter.
pub struct Reclaim {
    rx: Receiver<ReclaimMsg>,
    pub verb: &'static str,
    pub total: usize,
    pub done: usize,
    pub current: String,
    /// Per-step report lines (tool output tails, per-path notes).
    pub log: Vec<String>,
    /// Cumulative bytes we removed (our own `fs`-based estimate; `Run` steps
    /// report their own freed space to the log and contribute 0 here). This is a
    /// per-entry sum, so a file hardlinked across sibling subtrees can be
    /// counted more than once — hence the "~" the UI shows.
    pub freed: u64,
    /// True once any `Step::Run` executed this job.
    pub ran_command: bool,
    pub finished: bool,
}

impl Reclaim {
    /// Drain any pending messages; return true once the job has finished.
    pub fn poll(&mut self) -> bool {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                ReclaimMsg::Current { done, total, name } => {
                    self.done = done;
                    self.total = total;
                    self.current = name;
                }
                ReclaimMsg::Line(line) => self.log.push(line),
                ReclaimMsg::Freed(bytes) => self.freed = bytes,
                ReclaimMsg::Ran => self.ran_command = true,
                ReclaimMsg::Finished => {
                    self.finished = true;
                    self.done = self.total;
                }
            }
        }
        self.finished
    }
}

/// Spawn the worker thread and hand back a handle immediately.
pub fn spawn(job: Job) -> Reclaim {
    let (tx, rx) = mpsc::channel();
    let total = job.items.len();
    let first = job.items.first().map(|i| i.label.clone()).unwrap_or_default();

    thread::spawn(move || {
        let mut freed: u64 = 0;
        for (i, item) in job.items.iter().enumerate() {
            let _ = tx.send(ReclaimMsg::Current {
                done: i,
                total,
                name: item.label.clone(),
            });
            for step in &item.steps {
                run_step(step, &mut freed, &item.label, &tx);
                let _ = tx.send(ReclaimMsg::Freed(freed));
            }
        }
        let _ = tx.send(ReclaimMsg::Current {
            done: total,
            total,
            name: String::new(),
        });
        let _ = tx.send(ReclaimMsg::Finished);
    });

    Reclaim {
        rx,
        verb: "reclaiming",
        total,
        done: 0,
        current: first,
        log: Vec::new(),
        freed: 0,
        ran_command: false,
        finished: false,
    }
}

/// Execute a single step. Errors are reported to the log and swallowed so the
/// rest of the batch keeps going.
fn run_step(step: &Step, freed: &mut u64, label: &str, tx: &mpsc::Sender<ReclaimMsg>) {
    match step {
        Step::Run { program, args } => {
            let _ = tx.send(ReclaimMsg::Ran);
            let out = std::process::Command::new(program).args(args).output();
            match out {
                Ok(out) => {
                    // Tail of stdout+stderr — tools report their own freed space.
                    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
                    combined.push_str(&String::from_utf8_lossy(&out.stderr));
                    let tail: Vec<&str> = combined
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .collect();
                    let start = tail.len().saturating_sub(2);
                    let _ = tx.send(ReclaimMsg::Line(format!("{label}: {program} done")));
                    for line in &tail[start..] {
                        let _ = tx.send(ReclaimMsg::Line(format!("  {}", line.trim())));
                    }
                }
                Err(e) => {
                    let _ = tx.send(ReclaimMsg::Line(format!("{label}: {program}: {e}")));
                }
            }
        }
        Step::ClearDir { dir } => {
            // Skip missing or symlinked dirs — never follow a link.
            let meta = match std::fs::symlink_metadata(dir) {
                Ok(m) => m,
                Err(_) => return,
            };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(rd) => rd,
                Err(e) => {
                    let _ = tx.send(ReclaimMsg::Line(format!("{label}: {}: {e}", dir.display())));
                    return;
                }
            };
            for entry in entries.flatten() {
                let child = entry.path();
                remove_entry(&child, freed, label, tx);
            }
        }
        Step::RemovePaths { paths } => {
            for path in paths {
                remove_entry(path, freed, label, tx);
            }
        }
    }
}

/// Remove a single filesystem entry, adding its reclaimed size to `freed`. Uses
/// `symlink_metadata` so a symlink is unlinked (never followed), a directory is
/// removed as a tree, and a file/other is unlinked. Errors are logged, not fatal.
fn remove_entry(path: &Path, freed: &mut u64, label: &str, tx: &mpsc::Sender<ReclaimMsg>) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let ft = meta.file_type();
    let (size, result) = if ft.is_symlink() {
        // A symlink: count its own block usage, unlink it — NEVER remove_dir_all
        // (that would follow into the target).
        (
            meta.blocks().saturating_mul(512),
            std::fs::remove_file(path),
        )
    } else if ft.is_dir() {
        (walk_size(path), std::fs::remove_dir_all(path))
    } else {
        (meta.blocks().saturating_mul(512), std::fs::remove_file(path))
    };
    match result {
        Ok(()) => *freed = freed.saturating_add(size),
        Err(e) => {
            let _ = tx.send(ReclaimMsg::Line(format!(
                "{label}: {}: {e}",
                path.display()
            )));
        }
    }
}

/// A short "freed ~SIZE" summary for the status line once a job finishes.
pub fn freed_summary(bytes: u64) -> String {
    format!("freed ~{}", human_size(bytes))
}
