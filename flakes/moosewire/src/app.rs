//! Application state and input handling — the glue between the panes, the SSH
//! session and the transfer worker.

use std::time::Duration;

use crate::config::Target;
use crate::local;
use crate::model::{basename, join, parent, Entry, Side};
use crate::pane::Pane;
use crate::session::Session;
use crate::transfer::{self, Direction, Job, Transfer, TransferMsg};

/// Yanked set, kept until replaced or cleared (yazi-style).
struct Clip {
    side: Side,
    cut: bool,
    items: Vec<String>,
}

pub enum Mode {
    Normal,
    /// Live-filtering the active pane; buffer in `input`.
    Filter,
    /// Text prompt (mkdir / rename); buffer in `input`.
    Prompt(Prompt),
    /// Destructive confirmation; paths captured in the variant.
    Confirm(Vec<String>),
    Help,
}

pub enum Prompt {
    Mkdir,
    /// Rename the entry at this absolute path.
    Rename(String),
}

/// Copy tag of the current [`Mode`], used to dispatch key handling without
/// holding a borrow of `self.mode`.
#[derive(Clone, Copy)]
enum ModeKind {
    Normal,
    Filter,
    Prompt,
    Confirm,
    Help,
}

pub struct App {
    session: Session,
    pub local: Pane,
    pub remote: Pane,
    pub active: Side,
    pub transfer: Option<Transfer>,
    pub mode: Mode,
    pub input: String,
    pub message: String,
    clip: Option<Clip>,
    pub should_quit: bool,
}

impl App {
    pub fn new(session: Session) -> App {
        let remote_home = session.home();
        let mut app = App {
            session,
            local: Pane::new(local::start_dir()),
            remote: Pane::new(remote_home),
            active: Side::Local,
            transfer: None,
            mode: Mode::Normal,
            input: String::new(),
            message: "? for help · Tab switches panes · y yank · p paste · q quit".to_string(),
            clip: None,
            should_quit: false,
        };
        app.refresh(Side::Local);
        app.refresh(Side::Remote);
        app
    }

    pub fn remote_label(&self) -> String {
        format!("{}:{}", self.session.name, self.remote.cwd)
    }

    pub fn clip_summary(&self) -> Option<String> {
        self.clip.as_ref().map(|c| {
            format!(
                "{} {} item(s) {}",
                if c.cut { "cut" } else { "yanked" },
                c.items.len(),
                match c.side {
                    Side::Local => "from local",
                    Side::Remote => "from remote",
                }
            )
        })
    }

    fn pane(&self, side: Side) -> &Pane {
        match side {
            Side::Local => &self.local,
            Side::Remote => &self.remote,
        }
    }

    fn pane_mut(&mut self, side: Side) -> &mut Pane {
        match side {
            Side::Local => &mut self.local,
            Side::Remote => &mut self.remote,
        }
    }

    pub fn active_pane(&self) -> &Pane {
        self.pane(self.active)
    }

    fn list_side(&self, side: Side, path: &str) -> Result<Vec<Entry>, String> {
        match side {
            Side::Local => local::list(path),
            Side::Remote => self.session.list(path),
        }
    }

    fn refresh(&mut self, side: Side) {
        let path = self.pane(side).cwd.clone();
        match self.list_side(side, &path) {
            Ok(entries) => self.pane_mut(side).set_entries(entries),
            Err(e) => self.message = format!("{path}: {e}"),
        }
    }

    fn side_is_dir(&self, side: Side, path: &str) -> bool {
        match side {
            Side::Local => local::is_dir(path),
            Side::Remote => self.session.is_dir(path),
        }
    }

    // ---- navigation ----------------------------------------------------------

    fn enter(&mut self) {
        let side = self.active;
        if self.pane(side).is_on_parent() {
            self.up();
            return;
        }
        let Some(path) = self.pane(side).current_path() else {
            return;
        };
        if !self.side_is_dir(side, &path) {
            return; // files aren't opened
        }
        let pane = self.pane_mut(side);
        pane.cwd = path;
        pane.cursor = 0;
        pane.filter.clear();
        pane.clear_marks();
        self.refresh(side);
    }

    fn up(&mut self) {
        let side = self.active;
        let cwd = self.pane(side).cwd.clone();
        if cwd == "/" {
            return;
        }
        let leaving = basename(&cwd);
        let parent = parent(&cwd);
        {
            let pane = self.pane_mut(side);
            pane.cwd = parent;
            pane.cursor = 0;
            pane.filter.clear();
            pane.clear_marks();
        }
        self.refresh(side);
        // Land the cursor on the directory we came out of.
        if let Some(idx) = self.pane(side).view.iter().position(|e| e.name == leaving) {
            self.pane_mut(side).cursor_to(idx);
        }
    }

    // ---- transfer ------------------------------------------------------------

    fn yank(&mut self, cut: bool) {
        let side = self.active;
        let items = self.active_pane().action_paths();
        if items.is_empty() {
            self.message = "nothing to yank".to_string();
            return;
        }
        let n = items.len();
        self.clip = Some(Clip { side, cut, items });
        self.pane_mut(side).clear_marks();
        self.message = format!("{} {n} item(s)", if cut { "cut" } else { "yanked" });
    }

    fn paste(&mut self) {
        if self.transfer.is_some() {
            self.message = "a transfer is already running".to_string();
            return;
        }
        let Some(clip) = &self.clip else {
            self.message = "clipboard empty — yank with y first".to_string();
            return;
        };
        let dest_side = self.active;
        if clip.side == dest_side {
            self.message =
                "yanked from this side — Tab to the other pane to copy across".to_string();
            return;
        }
        let direction = match clip.side {
            Side::Local => Direction::Upload,
            Side::Remote => Direction::Download,
        };
        let dest_dir = self.pane(dest_side).cwd.clone();
        let job = Job {
            direction,
            spec: self.session.spec().to_string(),
            sock: self.session.control_path().clone(),
            port: self.session.port(),
            items: clip.items.clone(),
            dest_dir,
        };
        self.transfer = Some(transfer::spawn(job));
    }

    /// Poll the transfer worker; called every UI tick.
    pub fn tick(&mut self) {
        let Some(t) = &mut self.transfer else {
            return;
        };
        let mut finished: Option<Result<usize, String>> = None;
        while let Ok(msg) = t.rx.try_recv() {
            match msg {
                TransferMsg::Current { done, total, name } => {
                    t.done = done;
                    t.total = total;
                    t.current = name;
                }
                TransferMsg::Finished(res) => {
                    finished = Some(res);
                    break;
                }
            }
        }
        if let Some(res) = finished {
            let dest_side = self.active;
            self.transfer = None;
            match res {
                Ok(n) => {
                    self.finish_transfer(dest_side, n);
                }
                Err(e) => self.message = format!("transfer failed: {e}"),
            }
        }
    }

    fn finish_transfer(&mut self, dest_side: Side, n: usize) {
        // On a successful "cut", remove the sources, then refresh both sides.
        // Extract what we need from the clip first so its borrow ends before we
        // start mutating panes via refresh().
        let cut = self
            .clip
            .as_ref()
            .filter(|c| c.cut)
            .map(|c| (c.side, c.items.clone()));
        if let Some((src_side, items)) = cut {
            for p in &items {
                let _ = self.delete_side(src_side, p);
            }
            self.refresh(src_side);
            self.clip = None;
        }
        self.refresh(dest_side);
        self.message = format!("copied {n} item(s)");
    }

    // ---- mutating ops --------------------------------------------------------

    fn delete_side(&self, side: Side, path: &str) -> Result<(), String> {
        match side {
            Side::Local => local::delete(path),
            Side::Remote => self.session.delete(path),
        }
    }

    fn do_delete(&mut self, paths: Vec<String>) {
        let side = self.active;
        let mut errs = 0;
        for p in &paths {
            if self.delete_side(side, p).is_err() {
                errs += 1;
            }
        }
        self.pane_mut(side).clear_marks();
        self.refresh(side);
        self.message = if errs == 0 {
            format!("deleted {} item(s)", paths.len())
        } else {
            format!("deleted {} item(s), {errs} failed", paths.len() - errs)
        };
    }

    fn do_mkdir(&mut self, name: &str) {
        let side = self.active;
        let path = join(&self.pane(side).cwd, name);
        let res = match side {
            Side::Local => local::mkdir(&path),
            Side::Remote => self.session.mkdir(&path),
        };
        match res {
            Ok(()) => {
                self.refresh(side);
                self.message = format!("created {name}");
            }
            Err(e) => self.message = format!("mkdir failed: {e}"),
        }
    }

    fn do_rename(&mut self, from: &str, newname: &str) {
        let side = self.active;
        let to = join(&self.pane(side).cwd, newname);
        let res = match side {
            Side::Local => local::rename(from, &to),
            Side::Remote => self.session.rename(from, &to),
        };
        match res {
            Ok(()) => {
                self.refresh(side);
                self.message = format!("renamed to {newname}");
            }
            Err(e) => self.message = format!("rename failed: {e}"),
        }
    }

    // ---- input ---------------------------------------------------------------

    pub fn on_key(&mut self, key: ratatui::crossterm::event::KeyEvent) {
        use ratatui::crossterm::event::KeyModifiers;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        // Resolve the mode to a Copy tag first so no borrow of self.mode is held
        // while the handlers mutate self.
        match self.mode_kind() {
            ModeKind::Help => self.mode = Mode::Normal,
            ModeKind::Filter => self.key_filter(key),
            ModeKind::Prompt => self.key_prompt(key),
            ModeKind::Confirm => self.key_confirm(key),
            ModeKind::Normal => self.on_normal_key(key.code, ctrl),
        }
    }

    fn mode_kind(&self) -> ModeKind {
        match self.mode {
            Mode::Normal => ModeKind::Normal,
            Mode::Filter => ModeKind::Filter,
            Mode::Prompt(_) => ModeKind::Prompt,
            Mode::Confirm(_) => ModeKind::Confirm,
            Mode::Help => ModeKind::Help,
        }
    }

    fn key_filter(&mut self, key: ratatui::crossterm::event::KeyEvent) {
        use ratatui::crossterm::event::KeyCode;
        let side = self.active;
        match key.code {
            KeyCode::Esc => {
                self.input.clear();
                self.pane_mut(side).set_filter(String::new());
                self.mode = Mode::Normal;
            }
            KeyCode::Enter => self.mode = Mode::Normal,
            KeyCode::Backspace => {
                self.input.pop();
                let f = self.input.clone();
                self.pane_mut(side).set_filter(f);
            }
            KeyCode::Char(c) => {
                self.input.push(c);
                let f = self.input.clone();
                self.pane_mut(side).set_filter(f);
            }
            _ => {}
        }
    }

    fn key_prompt(&mut self, key: ratatui::crossterm::event::KeyEvent) {
        use ratatui::crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc => {
                self.input.clear();
                self.mode = Mode::Normal;
            }
            KeyCode::Enter => {
                let text = self.input.trim().to_string();
                self.input.clear();
                if let Mode::Prompt(p) = std::mem::replace(&mut self.mode, Mode::Normal) {
                    if !text.is_empty() {
                        match p {
                            Prompt::Mkdir => self.do_mkdir(&text),
                            Prompt::Rename(from) => self.do_rename(&from, &text),
                        }
                    }
                }
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => self.input.push(c),
            _ => {}
        }
    }

    fn key_confirm(&mut self, key: ratatui::crossterm::event::KeyEvent) {
        use ratatui::crossterm::event::KeyCode;
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                if let Mode::Confirm(paths) = std::mem::replace(&mut self.mode, Mode::Normal) {
                    self.do_delete(paths);
                }
            }
            _ => {
                self.mode = Mode::Normal;
                self.message = "delete cancelled".to_string();
            }
        }
    }

    fn on_normal_key(&mut self, code: ratatui::crossterm::event::KeyCode, ctrl: bool) {
        use ratatui::crossterm::event::KeyCode;
        let side = self.active;
        match code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('c') if ctrl => self.should_quit = true,
            KeyCode::Tab | KeyCode::Char('\t') => self.active = self.active.other(),
            KeyCode::Char('h') | KeyCode::Left | KeyCode::Backspace => self.up(),
            KeyCode::Char('l') | KeyCode::Right | KeyCode::Enter => self.enter(),
            KeyCode::Char('j') | KeyCode::Down => self.pane_mut(side).move_cursor(1),
            KeyCode::Char('k') | KeyCode::Up => self.pane_mut(side).move_cursor(-1),
            KeyCode::Char('d') if ctrl => self.pane_mut(side).move_cursor(10),
            KeyCode::Char('u') if ctrl => self.pane_mut(side).move_cursor(-10),
            KeyCode::PageDown => self.pane_mut(side).move_cursor(10),
            KeyCode::PageUp => self.pane_mut(side).move_cursor(-10),
            KeyCode::Char('g') | KeyCode::Home => self.pane_mut(side).cursor_to(0),
            KeyCode::Char('G') | KeyCode::End => {
                let last = self.pane(side).view.len().saturating_sub(1);
                self.pane_mut(side).cursor_to(last);
            }
            KeyCode::Char(' ') => {
                self.pane_mut(side).toggle_mark();
                self.pane_mut(side).move_cursor(1);
            }
            KeyCode::Char('y') => self.yank(false),
            KeyCode::Char('x') => self.yank(true),
            KeyCode::Char('p') => self.paste(),
            KeyCode::Char('d') => {
                let paths = self.active_pane().action_paths();
                if paths.is_empty() {
                    self.message = "nothing to delete".to_string();
                } else {
                    self.mode = Mode::Confirm(paths);
                }
            }
            KeyCode::Char('a') => {
                self.input.clear();
                self.mode = Mode::Prompt(Prompt::Mkdir);
            }
            KeyCode::Char('r') => {
                if let Some(path) = self.active_pane().current_path() {
                    self.input = basename(&path);
                    self.mode = Mode::Prompt(Prompt::Rename(path));
                }
            }
            KeyCode::Char('.') => self.pane_mut(side).toggle_hidden(),
            KeyCode::Char('/') => {
                self.input.clear();
                self.mode = Mode::Filter;
            }
            KeyCode::Char('R') => {
                self.refresh(Side::Local);
                self.refresh(Side::Remote);
                self.message = "refreshed".to_string();
            }
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Esc => {
                self.pane_mut(side).clear_marks();
                self.pane_mut(side).set_filter(String::new());
                self.clip = None;
                self.message = "cleared".to_string();
            }
            _ => {}
        }
    }
}

/// Non-interactive smoke test: connect, list a remote path, print it, exit.
pub fn run_ls(target: &Target, path: Option<&str>) -> Result<(), String> {
    let session = Session::open(target)?;
    let dir = match path {
        Some(p) => p.to_string(),
        None => session.home(),
    };
    let entries = session.list(&dir)?;
    println!("{} {}:", target.name, dir);
    let mut entries = entries;
    entries.sort_by(|a, b| {
        b.kind
            .is_dir()
            .cmp(&a.kind.is_dir())
            .then_with(|| a.name.cmp(&b.name))
    });
    for e in entries {
        let marker = if e.kind.is_dir() { "/" } else { "" };
        println!("  {}{}", e.name, marker);
    }
    Ok(())
}

/// The UI tick used by both the poll timeout and transfer refresh cadence.
pub const TICK: Duration = Duration::from_millis(120);
