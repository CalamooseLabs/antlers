//! Local filesystem backend — the left pane. Plain `std::fs`.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use crate::model::{Entry, Kind};

pub fn list(path: &str) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let read = fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        // symlink_metadata: don't follow, so we can flag links; fall back to a
        // followed stat to decide navigability of a link target.
        let meta = match item.metadata().or_else(|_| fs::symlink_metadata(item.path())) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ftype = item.file_type().ok();
        let kind = if ftype.map(|t| t.is_symlink()).unwrap_or(false) {
            Kind::Link
        } else if meta.is_dir() {
            Kind::Dir
        } else if meta.is_file() {
            Kind::File
        } else {
            Kind::Other
        };
        entries.push(Entry {
            name,
            kind,
            size: meta.len(),
            mtime: meta.mtime(),
        });
    }
    Ok(entries)
}

pub fn is_dir(path: &str) -> bool {
    Path::new(path).is_dir()
}

pub fn mkdir(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("{path}: {e}"))
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| format!("{from} -> {to}: {e}"))
}

pub fn delete(path: &str) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("{path}: {e}"))
    } else {
        fs::remove_file(path).map_err(|e| format!("{path}: {e}"))
    }
}

/// Starting local directory: current working dir, else `$HOME`, else `/`.
pub fn start_dir() -> String {
    std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string())
}
