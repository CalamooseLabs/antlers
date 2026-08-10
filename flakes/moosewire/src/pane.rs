//! One pane's view state: current directory, sorted entries, cursor, marks,
//! hidden-toggle and filter. Backend-agnostic — the app fills `entries` from
//! either the local FS or the SSH session.

use std::collections::HashSet;

use crate::model::{join, Entry, Kind};

pub struct Pane {
    pub cwd: String,
    /// All entries in `cwd`, sorted (dirs first, then case-insensitive name).
    all: Vec<Entry>,
    /// Rendered rows (a synthetic `..` first when not at root, then filtered).
    pub view: Vec<Entry>,
    pub cursor: usize,
    /// Marked entry names within `cwd`.
    pub selected: HashSet<String>,
    pub show_hidden: bool,
    pub filter: String,
}

impl Pane {
    pub fn new(cwd: String) -> Self {
        Pane {
            cwd,
            all: Vec::new(),
            view: Vec::new(),
            cursor: 0,
            selected: HashSet::new(),
            show_hidden: false,
            filter: String::new(),
        }
    }

    pub fn set_entries(&mut self, mut entries: Vec<Entry>) {
        entries.sort_by(|a, b| {
            let ad = a.kind.is_dir();
            let bd = b.kind.is_dir();
            bd.cmp(&ad)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        // Drop marks for entries that no longer exist.
        let present: HashSet<&String> = entries.iter().map(|e| &e.name).collect();
        self.selected.retain(|n| present.contains(n));
        self.all = entries;
        self.rebuild_view();
    }

    pub fn rebuild_view(&mut self) {
        let mut view = Vec::new();
        if self.cwd != "/" {
            view.push(Entry {
                name: "..".to_string(),
                kind: Kind::Dir,
                size: 0,
                mtime: 0,
            });
        }
        let filter = self.filter.to_lowercase();
        for e in &self.all {
            if !self.show_hidden && e.name.starts_with('.') {
                continue;
            }
            if !filter.is_empty() && !e.name.to_lowercase().contains(&filter) {
                continue;
            }
            view.push(e.clone());
        }
        self.view = view;
        if self.cursor >= self.view.len() {
            self.cursor = self.view.len().saturating_sub(1);
        }
    }

    pub fn current(&self) -> Option<&Entry> {
        self.view.get(self.cursor)
    }

    pub fn is_on_parent(&self) -> bool {
        self.current().map(|e| e.name == "..").unwrap_or(false)
    }

    /// Absolute path of the hovered entry (None on `..`).
    pub fn current_path(&self) -> Option<String> {
        let e = self.current()?;
        if e.name == ".." {
            None
        } else {
            Some(join(&self.cwd, &e.name))
        }
    }

    pub fn move_cursor(&mut self, delta: isize) {
        if self.view.is_empty() {
            return;
        }
        let max = self.view.len() as isize - 1;
        let next = (self.cursor as isize + delta).clamp(0, max);
        self.cursor = next as usize;
    }

    pub fn cursor_to(&mut self, idx: usize) {
        self.cursor = idx.min(self.view.len().saturating_sub(1));
    }

    pub fn toggle_hidden(&mut self) {
        self.show_hidden = !self.show_hidden;
        self.rebuild_view();
    }

    pub fn set_filter(&mut self, f: String) {
        self.filter = f;
        self.cursor = 0;
        self.rebuild_view();
    }

    pub fn toggle_mark(&mut self) {
        if let Some(e) = self.current() {
            if e.name == ".." {
                return;
            }
            let name = e.name.clone();
            if !self.selected.remove(&name) {
                self.selected.insert(name);
            }
        }
    }

    pub fn clear_marks(&mut self) {
        self.selected.clear();
    }

    /// Absolute paths to act on: marked entries if any, else the hovered entry.
    pub fn action_paths(&self) -> Vec<String> {
        if !self.selected.is_empty() {
            let mut names: Vec<&String> = self.selected.iter().collect();
            names.sort();
            names.into_iter().map(|n| join(&self.cwd, n)).collect()
        } else {
            self.current_path().into_iter().collect()
        }
    }
}
