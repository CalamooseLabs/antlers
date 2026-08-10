//! Background transfer worker.
//!
//! Each transfer runs on its own thread and drives `scp` once per selected
//! item, reusing the session's ControlMaster socket (`-o ControlPath=…`) so no
//! item costs another Yubikey touch. Progress is reported at file granularity
//! (item N of M) over a channel — scp only draws its byte-level meter to a real
//! TTY, and we pipe its stderr to capture errors, so we track completion by item
//! rather than pretending to parse a meter that isn't emitted.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use crate::model::{basename, sh_quote};

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
    /// About to copy `name`; `done` items already complete out of `total`.
    Current { done: usize, total: usize, name: String },
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

    thread::spawn(move || {
        let total = job.items.len();
        for (i, item) in job.items.iter().enumerate() {
            let _ = tx.send(TransferMsg::Current {
                done: i,
                total,
                name: basename(item),
            });
            if let Err(e) = copy_one(&job, item) {
                let _ = tx.send(TransferMsg::Finished(Err(format!(
                    "{}: {}",
                    basename(item),
                    e
                ))));
                return;
            }
        }
        let _ = tx.send(TransferMsg::Finished(Ok(total)));
    });

    Transfer {
        rx,
        verb,
        total,
        done: 0,
        current: first,
    }
}

fn copy_one(job: &Job, item: &str) -> Result<(), String> {
    let mut cmd = Command::new("scp");
    cmd.arg("-r")
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

    let out = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to launch scp: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
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
