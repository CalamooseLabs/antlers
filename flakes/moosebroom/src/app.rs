//! Application state and input handling — the glue between the reclaim probe,
//! the two views (reclaim list + disk scan), and the reclaim worker.
//!
//! The initial `probe::scan()` runs on a background thread (it shells out and
//! can take a few seconds) and lands over a channel; until then the reclaim
//! view shows "scanning…". Both the disk-scan sizing worker and the reclaim
//! executor are polled in `tick()`, mirroring how moosewire polls its transfer.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use crate::du::DiskView;
use crate::model::{human_size, is_root, Category, Step, Target};
use crate::probe;
use crate::reclaim::{self, Item, Job, Reclaim};

/// Which top-level view is showing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum View {
    Reclaim,
    Disk,
}

/// A pending destructive action, captured for the confirm prompt.
pub enum Pending {
    /// Reclaim these targets (by key), with a human summary already computed.
    Reclaim { keys: Vec<String> },
    /// Delete a single path from the disk view.
    Delete { path: PathBuf },
}

pub enum Mode {
    Normal,
    /// Destructive confirmation: the action + a one-line human summary.
    Confirm { action: Pending, summary: String },
    Help,
}

/// Copy tag of [`Mode`] used to dispatch keys without holding a borrow of
/// `self.mode`.
#[derive(Clone, Copy)]
enum ModeKind {
    Normal,
    Confirm,
    Help,
}

/// A rendered row in the reclaim list — headers are skipped by the cursor.
pub enum Row {
    Header(Category),
    Item(usize),
}

pub struct App {
    pub view: View,
    pub mode: Mode,

    pub targets: Vec<Target>,
    /// Flattened render rows (headers interleaved with items); cursor only ever
    /// lands on `Row::Item`.
    pub rows: Vec<Row>,
    pub cursor: usize,
    /// Marked target keys.
    pub marks: HashSet<String>,

    /// Startup probe in flight until the receiver yields.
    pub scanning: bool,
    scan_rx: Option<Receiver<Vec<Target>>>,

    pub disk: DiskView,
    pub reclaim: Option<Reclaim>,

    pub message: String,
    pub is_root: bool,
    pub should_quit: bool,
}

impl App {
    /// Build the app. `view` is the view to open in; `scan_root` seeds the disk
    /// view (default `$HOME`).
    pub fn new(view: View, scan_root: PathBuf) -> App {
        // Kick off the reclaim probe in the background.
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(probe::scan());
        });

        let is_root = is_root();
        let mut app = App {
            view,
            mode: Mode::Normal,
            targets: Vec::new(),
            rows: Vec::new(),
            cursor: 0,
            marks: HashSet::new(),
            scanning: true,
            scan_rx: Some(rx),
            disk: DiskView::new(scan_root),
            reclaim: None,
            message: match view {
                View::Reclaim => "scanning… · ? for help".to_string(),
                View::Disk => "s reclaim · ? for help · q quit".to_string(),
            },
            is_root,
            should_quit: false,
        };
        app.rebuild_rows();
        app
    }

    // ---- reclaim-view helpers -----------------------------------------------

    /// Rebuild the flat row list: a header per non-empty category, then its
    /// targets in probe order.
    fn rebuild_rows(&mut self) {
        let mut rows = Vec::new();
        for cat in Category::ALL {
            let mut header_pushed = false;
            for (i, t) in self.targets.iter().enumerate() {
                if t.category != cat {
                    continue;
                }
                if !header_pushed {
                    rows.push(Row::Header(cat));
                    header_pushed = true;
                }
                rows.push(Row::Item(i));
            }
        }
        self.rows = rows;
        // Keep the cursor on a real item.
        if self.cursor >= self.rows.len() {
            self.cursor = self.rows.len().saturating_sub(1);
        }
        self.snap_to_item(1);
    }

    /// Is the target at index `i` locked (unmarkable)? Empty targets and
    /// root-only targets when not root are locked.
    pub fn is_locked(&self, i: usize) -> bool {
        let t = &self.targets[i];
        t.is_empty() || (t.needs_root && !self.is_root)
    }

    /// Index of the target under the cursor, if the cursor is on an item.
    fn hovered_target(&self) -> Option<usize> {
        match self.rows.get(self.cursor) {
            Some(Row::Item(i)) => Some(*i),
            _ => None,
        }
    }

    /// Move the cursor by `delta`, then land on the nearest `Row::Item` in that
    /// direction (skipping category headers).
    fn move_cursor(&mut self, delta: isize) {
        if self.rows.is_empty() {
            return;
        }
        let max = self.rows.len() as isize - 1;
        let mut idx = (self.cursor as isize + delta).clamp(0, max);
        let step = if delta >= 0 { 1 } else { -1 };
        // Walk in the travel direction until we hit an Item or a boundary.
        while matches!(self.rows.get(idx as usize), Some(Row::Header(_))) {
            let next = idx + step;
            if next < 0 || next > max {
                break;
            }
            idx = next;
        }
        // If we ran into a boundary on a header, reverse to find the last item.
        if matches!(self.rows.get(idx as usize), Some(Row::Header(_))) {
            let back = -step;
            let mut j = idx;
            while matches!(self.rows.get(j as usize), Some(Row::Header(_))) {
                let next = j + back;
                if next < 0 || next > max {
                    return;
                }
                j = next;
            }
            idx = j;
        }
        self.cursor = idx as usize;
    }

    /// Snap the cursor onto an item, searching in direction `dir` (1 or -1).
    fn snap_to_item(&mut self, dir: isize) {
        if self.rows.is_empty() {
            self.cursor = 0;
            return;
        }
        let max = self.rows.len() as isize - 1;
        let mut idx = (self.cursor as isize).clamp(0, max);
        while matches!(self.rows.get(idx as usize), Some(Row::Header(_))) {
            let next = idx + dir;
            if next < 0 || next > max {
                // Fall back to scanning the other way.
                let mut j = idx;
                while matches!(self.rows.get(j as usize), Some(Row::Header(_))) {
                    let n = j - dir;
                    if n < 0 || n > max {
                        return;
                    }
                    j = n;
                }
                idx = j;
                break;
            }
            idx = next;
        }
        self.cursor = idx as usize;
    }

    fn cursor_top(&mut self) {
        self.cursor = 0;
        self.snap_to_item(1);
    }

    fn cursor_bottom(&mut self) {
        self.cursor = self.rows.len().saturating_sub(1);
        self.snap_to_item(-1);
    }

    /// Bytes summary for a target: known size or "—".
    pub fn target_size(t: &Target) -> String {
        match t.bytes {
            Some(b) => human_size(b),
            None => "—".to_string(),
        }
    }

    /// Total marked count + estimated reclaimable bytes (unknowns omitted).
    pub fn marked_summary(&self) -> (usize, u64) {
        let mut count = 0;
        let mut bytes = 0u64;
        for t in &self.targets {
            if self.marks.contains(&t.key) {
                count += 1;
                if let Some(b) = t.bytes {
                    bytes = bytes.saturating_add(b);
                }
            }
        }
        (count, bytes)
    }

    fn toggle_mark(&mut self) {
        let Some(i) = self.hovered_target() else {
            return;
        };
        if self.is_locked(i) {
            self.message = "locked — nothing to reclaim (or needs sudo)".to_string();
            return;
        }
        let key = self.targets[i].key.clone();
        if !self.marks.remove(&key) {
            self.marks.insert(key);
        }
    }

    fn mark_all(&mut self) {
        for i in 0..self.targets.len() {
            if !self.is_locked(i) {
                self.marks.insert(self.targets[i].key.clone());
            }
        }
        let (n, _) = self.marked_summary();
        self.message = format!("marked {n} unlocked target(s)");
    }

    /// Keys to reclaim: the marked set, or the hovered target if nothing marked.
    fn action_keys(&self) -> Vec<String> {
        if !self.marks.is_empty() {
            self.targets
                .iter()
                .filter(|t| self.marks.contains(&t.key))
                .map(|t| t.key.clone())
                .collect()
        } else if let Some(i) = self.hovered_target() {
            if self.is_locked(i) {
                Vec::new()
            } else {
                vec![self.targets[i].key.clone()]
            }
        } else {
            Vec::new()
        }
    }

    fn request_reclaim(&mut self) {
        if self.reclaim.is_some() {
            return; // a job is already running
        }
        let keys = self.action_keys();
        if keys.is_empty() {
            self.message = "nothing marked to reclaim".to_string();
            return;
        }
        let mut bytes = 0u64;
        let mut clears: Vec<String> = Vec::new();
        let mut runs: Vec<String> = Vec::new();
        for t in &self.targets {
            if !keys.contains(&t.key) {
                continue;
            }
            if let Some(b) = t.bytes {
                bytes = bytes.saturating_add(b);
            }
            for step in &t.steps {
                match step {
                    Step::ClearDir { dir } => clears.push(dir.display().to_string()),
                    Step::RemovePaths { paths } => {
                        clears.extend(paths.iter().map(|p| p.display().to_string()))
                    }
                    Step::Run { program, .. } => runs.push(program.clone()),
                }
            }
        }
        // Spell out the concrete destructive paths (mirroring the disk-delete
        // confirm) so what will actually be touched is always visible.
        let mut what: Vec<String> = Vec::new();
        if !clears.is_empty() {
            what.push(format!("delete {}", clears.join(", ")));
        }
        if !runs.is_empty() {
            what.push(format!("run {}", runs.join(", ")));
        }
        let summary = format!(
            "reclaim {} target(s) (~{}) — {}? [y/N]",
            keys.len(),
            human_size(bytes),
            what.join(" · ")
        );
        self.mode = Mode::Confirm {
            action: Pending::Reclaim { keys },
            summary,
        };
    }

    fn start_reclaim(&mut self, keys: &[String]) {
        let items: Vec<Item> = self
            .targets
            .iter()
            .filter(|t| keys.contains(&t.key))
            .map(|t| Item {
                label: t.label.clone(),
                steps: t.steps.clone(),
            })
            .collect();
        if items.is_empty() {
            return;
        }
        self.reclaim = Some(reclaim::spawn(Job { items }));
        self.marks.clear();
        self.message = "reclaiming…".to_string();
    }

    /// Rerun the reclaim probe in the background.
    fn rescan_reclaim(&mut self) {
        if self.scanning {
            return;
        }
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(probe::scan());
        });
        self.scan_rx = Some(rx);
        self.scanning = true;
        self.message = "rescanning…".to_string();
    }

    // ---- disk-view helpers ---------------------------------------------------

    fn request_delete(&mut self) {
        if self.reclaim.is_some() {
            return;
        }
        let Some(child) = self.disk.hovered() else {
            return;
        };
        let path = child.path.clone();
        let size = child.size.map(human_size).unwrap_or_else(|| "?".to_string());
        let summary = format!("delete {} (~{})? [y/N]", path.display(), size);
        self.mode = Mode::Confirm {
            action: Pending::Delete { path },
            summary,
        };
    }

    fn start_delete(&mut self, path: PathBuf) {
        let item = Item {
            label: crate::model::basename(&path),
            steps: vec![crate::model::Step::RemovePaths {
                paths: vec![path.clone()],
            }],
        };
        self.reclaim = Some(reclaim::spawn(Job { items: vec![item] }));
        self.disk.invalidate(&path);
        self.message = "deleting…".to_string();
    }

    // ---- tick ----------------------------------------------------------------

    /// Poll the background workers; called every UI tick.
    pub fn tick(&mut self) {
        // Startup / rescan probe result.
        if self.scanning {
            if let Some(rx) = &self.scan_rx {
                if let Ok(targets) = rx.try_recv() {
                    self.targets = targets;
                    self.scanning = false;
                    self.scan_rx = None;
                    // Drop marks whose targets vanished or became locked.
                    let keep: HashSet<String> = self
                        .targets
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| !self.is_locked(*i))
                        .map(|(_, t)| t.key.clone())
                        .collect();
                    self.marks.retain(|k| keep.contains(k));
                    self.rebuild_rows();
                    self.cursor_top();
                    let (n, _) = self.marked_summary();
                    self.message = if n > 0 {
                        format!("{n} marked · scan complete")
                    } else {
                        "scan complete · Space to mark, c to reclaim".to_string()
                    };
                }
            }
        }

        // Disk sizing worker.
        self.disk.poll();

        // Reclaim worker.
        let mut done: Option<(u64, bool)> = None;
        if let Some(r) = &mut self.reclaim {
            if r.poll() {
                done = Some((r.freed, r.ran_command));
            }
        }
        if let Some((freed, ran_command)) = done {
            self.reclaim = None;
            // A command-only reclaim (nix gc, journal vacuum, prune) frees space
            // the tool reports to the log, not to `freed` — don't claim ~0B.
            self.message = if freed == 0 && ran_command {
                "done · freed space (see log)".to_string()
            } else {
                format!("done · {}", reclaim::freed_summary(freed))
            };
            // Refresh whichever view we acted in.
            match self.view {
                View::Reclaim => self.rescan_reclaim(),
                View::Disk => self.disk.rescan(),
            }
        }
    }

    // ---- input ---------------------------------------------------------------

    pub fn on_key(&mut self, key: KeyEvent) {
        // A running job locks out action keys — let the poll finish (moosewire).
        match self.mode_kind() {
            ModeKind::Help => self.mode = Mode::Normal,
            ModeKind::Confirm => self.key_confirm(key),
            ModeKind::Normal => {
                if self.reclaim.is_some() {
                    // Only quit is honored while a job runs.
                    if matches!(key.code, KeyCode::Char('q')) {
                        self.should_quit = true;
                    }
                    return;
                }
                match self.view {
                    View::Reclaim => self.key_reclaim(key),
                    View::Disk => self.key_disk(key),
                }
            }
        }
    }

    fn mode_kind(&self) -> ModeKind {
        match self.mode {
            Mode::Normal => ModeKind::Normal,
            Mode::Confirm { .. } => ModeKind::Confirm,
            Mode::Help => ModeKind::Help,
        }
    }

    fn key_confirm(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                if let Mode::Confirm { action, .. } =
                    std::mem::replace(&mut self.mode, Mode::Normal)
                {
                    match action {
                        Pending::Reclaim { keys } => self.start_reclaim(&keys),
                        Pending::Delete { path } => self.start_delete(path),
                    }
                }
            }
            _ => {
                self.mode = Mode::Normal;
                self.message = "cancelled".to_string();
            }
        }
    }

    fn key_reclaim(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('j') | KeyCode::Down => self.move_cursor(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_cursor(-1),
            KeyCode::Char('g') | KeyCode::Home => self.cursor_top(),
            KeyCode::Char('G') | KeyCode::End => self.cursor_bottom(),
            KeyCode::Char(' ') => self.toggle_mark(),
            KeyCode::Char('a') => self.mark_all(),
            KeyCode::Char('c') | KeyCode::Enter => self.request_reclaim(),
            KeyCode::Char('s') => {
                self.view = View::Disk;
                self.message = "disk scan · s/Esc back · d delete".to_string();
            }
            KeyCode::Char('R') => self.rescan_reclaim(),
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Esc => {
                self.marks.clear();
                self.message = "marks cleared".to_string();
            }
            _ => {}
        }
    }

    fn key_disk(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('j') | KeyCode::Down => self.disk.move_cursor(1),
            KeyCode::Char('k') | KeyCode::Up => self.disk.move_cursor(-1),
            KeyCode::Char('l') | KeyCode::Right | KeyCode::Enter => self.disk.enter(),
            KeyCode::Char('h') | KeyCode::Left | KeyCode::Backspace => self.disk.up(),
            KeyCode::Char('g') | KeyCode::Home => self.disk.cursor_to(0),
            KeyCode::Char('G') | KeyCode::End => {
                let last = self.disk.children.len().saturating_sub(1);
                self.disk.cursor_to(last);
            }
            KeyCode::Char('d') => self.request_delete(),
            KeyCode::Char('R') => {
                self.disk.rescan();
                self.message = "rescanning…".to_string();
            }
            KeyCode::Char('s') | KeyCode::Esc => {
                self.view = View::Reclaim;
                self.message = "reclaim · Space mark · c reclaim".to_string();
            }
            KeyCode::Char('?') => self.mode = Mode::Help,
            _ => {}
        }
    }
}

/// Non-interactive smoke test: probe and print every target grouped by category,
/// with a total. NEVER executes a destructive step — read-only.
pub fn run_report() -> i32 {
    let targets = probe::scan();
    let root = is_root();
    let mut total: u64 = 0;
    for cat in Category::ALL {
        let cat_targets: Vec<&Target> = targets.iter().filter(|t| t.category == cat).collect();
        if cat_targets.is_empty() {
            continue;
        }
        println!("{}", cat.title());
        for t in cat_targets {
            let size = App::target_size(t);
            let root_locked = t.needs_root && !root;
            let state = if t.is_empty() {
                "  (locked)"
            } else if root_locked {
                "  (sudo)"
            } else {
                ""
            };
            // Only count what this user can actually reclaim, matching the
            // "(run under sudo …)" footer below.
            if let Some(b) = t.bytes {
                if !root_locked {
                    total = total.saturating_add(b);
                }
            }
            println!("  {:<26} {:>8}  {}{}", t.label, size, t.detail, state);
        }
        println!();
    }
    println!("total known reclaimable: ~{}", human_size(total));
    if !root {
        println!("(run under sudo to include root-only targets)");
    }
    0
}

/// The UI tick used by both the poll timeout and worker refresh cadence.
pub const TICK: Duration = Duration::from_millis(120);
