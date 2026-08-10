//! Background transfer worker.
//!
//! Each transfer runs on its own thread and drives `scp -O` once per selected
//! item, reusing the session's ControlMaster socket (`-o ControlPath=…`) so no
//! item costs another Yubikey touch.
//!
//! scp only draws its byte meter to a real TTY, and we capture its output to
//! catch errors — so instead of parsing a meter that isn't emitted, we size the
//! whole job up front and, while each `scp` runs, poll the *destination* copy's
//! size (the remote file over the master for uploads, the local file for
//! downloads). That drives a real byte-level %, a smoothed transfer rate and an
//! ETA. The remote side still needs nothing but coreutils (`du`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crate::model::{basename, sh_quote};

/// How often to poll the destination size while a file is in flight.
const POLL: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Local -> remote.
    Upload,
    /// Remote -> local.
    Download,
}

pub struct Job {
    pub direction: Direction,
    /// `user@addr` of the connected host.
    pub spec: String,
    pub sock: PathBuf,
    pub port: u16,
    /// Absolute source paths on the source side.
    pub items: Vec<String>,
    /// Absolute destination directory on the destination side.
    pub dest_dir: String,
}

pub enum TransferMsg {
    /// Total bytes to move, once sized (0 = couldn't size → item-only progress).
    Total(u64),
    /// About to copy `name`; `done` items already complete out of `total`.
    Item { done: usize, total: usize, name: String },
    /// Cumulative bytes moved so far.
    Bytes(u64),
    /// All items handled: Ok(count) or Err(message).
    Finished(Result<usize, String>),
}

/// Live handle the UI polls each tick.
pub struct Transfer {
    pub rx: Receiver<TransferMsg>,
    pub verb: &'static str,
    pub total: usize,
    pub done: usize,
    pub current: String,
    /// Total bytes to move (0 until known / unsizable → fall back to items).
    pub total_bytes: u64,
    pub bytes_done: u64,
    /// Smoothed throughput in bytes/sec (0 until there are enough samples).
    pub rate: f64,
    last_t: Instant,
    last_bytes: u64,
}

impl Transfer {
    /// Byte-accurate completion fraction when the job could be sized, else the
    /// item fraction.
    pub fn ratio(&self) -> f64 {
        if self.total_bytes > 0 {
            (self.bytes_done as f64 / self.total_bytes as f64).clamp(0.0, 1.0)
        } else if self.total > 0 {
            (self.done as f64 / self.total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    /// Seconds until done, from the smoothed rate (None until it's meaningful).
    pub fn eta_secs(&self) -> Option<u64> {
        if self.total_bytes > self.bytes_done && self.rate > 1.0 {
            Some(((self.total_bytes - self.bytes_done) as f64 / self.rate) as u64)
        } else {
            None
        }
    }

    /// Apply one worker message. `Finished` is handed back to the caller (app
    /// tick) to unwind the transfer; the rest update progress in place.
    pub fn apply(&mut self, msg: TransferMsg) -> Option<Result<usize, String>> {
        match msg {
            TransferMsg::Total(b) => self.total_bytes = b,
            TransferMsg::Item { done, total, name } => {
                self.done = done;
                self.total = total;
                self.current = name;
            }
            TransferMsg::Bytes(b) => self.note_bytes(b),
            TransferMsg::Finished(res) => return Some(res),
        }
        None
    }

    /// Fold in a cumulative byte count, updating the smoothed rate (EMA over
    /// ≥0.2s samples so a 400ms poll cadence yields a steady figure).
    fn note_bytes(&mut self, bytes: u64) {
        let now = Instant::now();
        let dt = now.duration_since(self.last_t).as_secs_f64();
        if dt >= 0.2 {
            let inst = bytes.saturating_sub(self.last_bytes) as f64 / dt;
            self.rate = if self.rate == 0.0 {
                inst
            } else {
                0.6 * self.rate + 0.4 * inst
            };
            self.last_t = now;
            self.last_bytes = bytes;
        }
        // Never let a late/rounded poll walk the bar backwards.
        self.bytes_done = bytes.max(self.bytes_done);
    }
}

/// Spawn the worker thread and return a handle immediately.
pub fn spawn(job: Job) -> Transfer {
    let (tx, rx) = mpsc::channel();
    let verb = match job.direction {
        Direction::Upload => "Uploading",
        Direction::Download => "Downloading",
    };
    let total = job.items.len();
    let first = job.items.first().map(|p| basename(p)).unwrap_or_default();

    thread::spawn(move || run_job(job, &tx));

    let now = Instant::now();
    Transfer {
        rx,
        verb,
        total,
        done: 0,
        current: first,
        total_bytes: 0,
        bytes_done: 0,
        rate: 0.0,
        last_t: now,
        last_bytes: 0,
    }
}

fn run_job(job: Job, tx: &Sender<TransferMsg>) {
    let total = job.items.len();
    let sizes = item_sizes(&job);
    let total_bytes: u64 = sizes.iter().sum();
    let track_bytes = total_bytes > 0;
    let _ = tx.send(TransferMsg::Total(total_bytes));

    let mut base: u64 = 0;
    for (i, item) in job.items.iter().enumerate() {
        let _ = tx.send(TransferMsg::Item {
            done: i,
            total,
            name: basename(item),
        });
        let item_bytes = sizes.get(i).copied().unwrap_or(0);
        if let Err(e) = copy_one(&job, item, base, item_bytes, track_bytes, tx) {
            let _ = tx.send(TransferMsg::Finished(Err(format!("{}: {}", basename(item), e))));
            return;
        }
        // Snap to the exact item boundary, correcting any poll estimate drift.
        base = base.saturating_add(item_bytes);
        let _ = tx.send(TransferMsg::Bytes(base));
    }
    let _ = tx.send(TransferMsg::Finished(Ok(total)));
}

/// Copy one item with `scp -O`, polling the destination size while it runs so
/// the gauge advances within a single (possibly large) file.
fn copy_one(
    job: &Job,
    item: &str,
    base: u64,
    item_bytes: u64,
    track_bytes: bool,
    tx: &Sender<TransferMsg>,
) -> Result<(), String> {
    let mut cmd = Command::new("scp");
    // -O forces the legacy SCP protocol. Since OpenSSH 9.0, scp defaults to
    // SFTP, where the remote path is NOT expanded by a remote login shell — so
    // the single quotes sh_quote() adds are taken *literally* and every remote
    // path fails ("scp: '/home/hub/log.txt': No such file or directory").
    // Legacy protocol runs the remote path through the shell, which is exactly
    // what sh_quote() targets, so spaces and metacharacters resolve correctly.
    cmd.arg("-O")
        .arg("-r")
        .arg("-p")
        .args(["-o", "ControlMaster=no"])
        .arg("-o")
        .arg(format!("ControlPath={}", job.sock.display()))
        .arg("-P")
        .arg(job.port.to_string());

    match job.direction {
        Direction::Upload => {
            // local source (plain argv) -> remote dir (shell-quoted after ':').
            cmd.arg(item);
            cmd.arg(format!("{}:{}", job.spec, sh_quote(&job.dest_dir)));
        }
        Direction::Download => {
            // remote source (shell-quoted after ':') -> local dir (plain argv).
            cmd.arg(format!("{}:{}", job.spec, sh_quote(item)));
            cmd.arg(&job.dest_dir);
        }
    }

    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch scp: {e}"))?;

    let dest = dest_path(job, item);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return finish_child(child, status),
            Ok(None) => {
                if track_bytes {
                    let moved = current_size(job, &dest).min(item_bytes);
                    let _ = tx.send(TransferMsg::Bytes(base.saturating_add(moved)));
                }
                thread::sleep(POLL);
            }
            Err(e) => return Err(format!("scp wait failed: {e}")),
        }
    }
}

/// Drain scp's stderr and map the exit status to a result. Reads stderr only
/// after exit — with the meter suppressed (non-TTY) scp is near-silent on
/// success, so the pipe never fills.
fn finish_child(mut child: Child, status: ExitStatus) -> Result<(), String> {
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    if status.success() {
        Ok(())
    } else {
        let msg = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("scp failed")
            .trim()
            .to_string();
        Err(msg)
    }
}

// ---- sizing ------------------------------------------------------------------

/// Per-item byte sizes (apparent). Upload sizes come from the local FS; download
/// sizes from one remote `du -sb` over all items. Returns all-zero (→ item-only
/// progress) if the remote sizing is unavailable or doesn't line up 1:1 with the
/// item list.
fn item_sizes(job: &Job) -> Vec<u64> {
    match job.direction {
        Direction::Upload => job
            .items
            .iter()
            .map(|p| local_apparent_size(Path::new(p)))
            .collect(),
        Direction::Download => {
            let args: Vec<String> = job.items.iter().map(|p| sh_quote(p)).collect();
            let cmd = format!("du -sb -- {} 2>/dev/null", args.join(" "));
            let sizes: Vec<u64> = remote_out(job, &cmd)
                .map(|out| {
                    out.lines()
                        .filter_map(|l| l.split('\t').next())
                        .filter_map(|s| s.trim().parse().ok())
                        .collect()
                })
                .unwrap_or_default();
            if sizes.len() == job.items.len() {
                sizes
            } else {
                vec![0; job.items.len()] // couldn't size cleanly → item-only
            }
        }
    }
}

/// Bytes already written to the destination copy of the current item.
fn current_size(job: &Job, dest: &str) -> u64 {
    match job.direction {
        // Upload lands on the remote: ask it (coreutils `du`) over the master.
        Direction::Upload => remote_size(job, dest),
        // Download lands locally: just stat the growing tree.
        Direction::Download => local_apparent_size(Path::new(dest)),
    }
}

/// Destination path of `item` on the receiving side: `<dest_dir>/<basename>`.
fn dest_path(job: &Job, item: &str) -> String {
    let name = basename(item);
    let d = &job.dest_dir;
    if d.ends_with('/') {
        format!("{d}{name}")
    } else {
        format!("{d}/{name}")
    }
}

/// Apparent size (sum of file lengths) of a remote path via `du -sb`; 0 if it's
/// missing or errors (e.g. not created yet).
fn remote_size(job: &Job, path: &str) -> u64 {
    let cmd = format!("du -sb -- {} 2>/dev/null", sh_quote(path));
    remote_out(job, &cmd)
        .and_then(|s| s.split('\t').next().map(str::trim).map(str::to_string))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Run a remote command over the ControlMaster and return stdout (None on fail).
fn remote_out(job: &Job, command: &str) -> Option<String> {
    let out = Command::new("ssh")
        .arg("-S")
        .arg(&job.sock)
        .args(["-o", "ControlMaster=no"])
        .arg(&job.spec)
        .arg(command)
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        None
    }
}

/// Apparent size (sum of file lengths) of a local path, recursing directories
/// and not following symlinks. Unreadable entries are skipped.
fn local_apparent_size(path: &Path) -> u64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.file_type().is_symlink() {
        0
    } else if meta.is_dir() {
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(path) {
            for e in rd.flatten() {
                total = total.saturating_add(local_apparent_size(&e.path()));
            }
        }
        total
    } else {
        meta.len()
    }
}
