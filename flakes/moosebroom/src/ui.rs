//! Rendering. The reclaim list (category sections, marked/locked rows, a total),
//! the ncdu-style disk list, a reclaim gauge, a status/confirm line, and a
//! centered help overlay. Colors/idioms match moosewire (`ACTIVE = Cyan`,
//! `DIM = DarkGray`).

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Gauge, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, Mode, Row, View};
use crate::model::{human_size, Category, Target};

const ACTIVE: Color = Color::Cyan;
const DIM: Color = Color::DarkGray;

pub fn draw(frame: &mut Frame, app: &App) {
    let show_gauge = app.reclaim.is_some();
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(if show_gauge { 1 } else { 0 }),
            Constraint::Length(1),
        ])
        .split(frame.area());

    match app.view {
        View::Reclaim => render_reclaim(frame, rows[0], app),
        View::Disk => render_disk(frame, rows[0], app),
    }

    if show_gauge {
        render_gauge(frame, rows[1], app);
    }
    render_status(frame, rows[2], app);

    if matches!(app.mode, Mode::Help) {
        render_help(frame, app.view);
    }
}

// ---- reclaim view ------------------------------------------------------------

fn render_reclaim(frame: &mut Frame, area: Rect, app: &App) {
    let (marked, bytes) = app.marked_summary();
    let title = if app.scanning {
        " RECLAIM · scanning… ".to_string()
    } else {
        format!(" RECLAIM · marked: {marked} · ~{} ", human_size(bytes))
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD))
        .title(title);

    let inner_w = area.width.saturating_sub(2) as usize;

    // Map cursor to a list index and build one ListItem per row.
    let mut items: Vec<ListItem> = Vec::new();
    for r in &app.rows {
        match r {
            Row::Header(cat) => items.push(header_row(*cat)),
            Row::Item(i) => {
                let t = &app.targets[*i];
                let locked = app.is_locked(*i);
                let marked = app.marks.contains(&t.key);
                items.push(target_row(t, marked, locked, app.is_root, inner_w));
            }
        }
    }

    let highlight = Style::default()
        .bg(ACTIVE)
        .fg(Color::Black)
        .add_modifier(Modifier::BOLD);
    let list = List::new(items)
        .block(block)
        .highlight_style(highlight)
        .highlight_symbol("");

    let mut state = ListState::default();
    if !app.rows.is_empty() {
        state.select(Some(app.cursor));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn header_row(cat: Category) -> ListItem<'static> {
    ListItem::new(Line::from(Span::styled(
        cat.title().to_string(),
        Style::default().fg(DIM).add_modifier(Modifier::BOLD),
    )))
}

fn target_row(
    t: &Target,
    marked: bool,
    locked: bool,
    is_root: bool,
    width: usize,
) -> ListItem<'static> {
    let mark = if marked { "*" } else { " " };
    let size = match t.bytes {
        Some(b) => human_size(b),
        None => "—".to_string(),
    };

    // A locked hint: "(sudo)" when it's a root-only target we can't run yet,
    // else a plain lock.
    let lock_hint = if t.needs_root && !is_root {
        " (sudo)"
    } else if locked {
        " (locked)"
    } else {
        ""
    };
    let detail = format!("{}{}", t.detail, lock_hint);

    // Left: mark + label; middle: dim detail; right: right-aligned size.
    let label_style = if marked {
        Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
    } else if locked {
        Style::default().fg(DIM)
    } else {
        Style::default().fg(Color::Reset)
    };
    let detail_style = Style::default().fg(DIM);

    let left = format!("  {} {}  ", mark, t.label);
    let left_len = left.chars().count();
    let size_len = size.chars().count();
    let detail_len = detail.chars().count();
    // Pad between detail and the right-aligned size.
    let used = left_len + detail_len + size_len;
    let pad = width.saturating_sub(used);

    let line = Line::from(vec![
        Span::styled(
            format!("  {} ", mark),
            Style::default().fg(Color::Yellow),
        ),
        Span::styled(format!("{}  ", t.label), label_style),
        Span::styled(detail, detail_style),
        Span::raw(" ".repeat(pad)),
        Span::styled(size, Style::default().fg(if marked { Color::Yellow } else { DIM })),
    ]);
    ListItem::new(line)
}

// ---- disk view ---------------------------------------------------------------

fn render_disk(frame: &mut Frame, area: Rect, app: &App) {
    let total = app.disk.total();
    let title = format!(
        " DISK · {} · ~{} ",
        app.disk.cwd.display(),
        human_size(total)
    );
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD))
        .title(title);

    let inner_w = area.width.saturating_sub(2) as usize;
    let items: Vec<ListItem> = app
        .disk
        .children
        .iter()
        .map(|c| disk_row(c, inner_w))
        .collect();

    let highlight = Style::default()
        .bg(ACTIVE)
        .fg(Color::Black)
        .add_modifier(Modifier::BOLD);
    let list = List::new(items)
        .block(block)
        .highlight_style(highlight)
        .highlight_symbol("");

    let mut state = ListState::default();
    if !app.disk.children.is_empty() {
        state.select(Some(app.disk.cursor));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn disk_row(c: &crate::du::Child, width: usize) -> ListItem<'static> {
    use crate::model::{human_time, Kind};
    let (suffix, color) = match c.kind {
        Kind::Dir => ("/", Color::Blue),
        Kind::Link => ("@", Color::Cyan),
        Kind::Other => ("", Color::Magenta),
        Kind::File => ("", Color::Reset),
    };
    let name = format!("{}{}", c.name, suffix);
    let size = match c.size {
        Some(b) => human_size(b),
        None => "…".to_string(),
    };
    // Right column: modification age + size (age blank when unknown).
    let age = human_time(c.mtime);
    let right = if age.is_empty() {
        size
    } else {
        format!("{:>4}  {}", age, size)
    };
    let left_len = 2 + name.chars().count();
    let right_len = right.chars().count();
    let pad = width.saturating_sub(left_len + right_len + 1);

    let line = Line::from(vec![
        Span::raw("  "),
        Span::styled(name, Style::default().fg(color)),
        Span::raw(" ".repeat(pad)),
        Span::styled(right, Style::default().fg(DIM)),
    ]);
    ListItem::new(line)
}

// ---- gauge / status / help ---------------------------------------------------

fn render_gauge(frame: &mut Frame, area: Rect, app: &App) {
    let r = app.reclaim.as_ref().unwrap();
    let ratio = if r.total == 0 {
        0.0
    } else {
        (r.done as f64 / r.total as f64).clamp(0.0, 1.0)
    };
    // Only assert freed bytes once we've actually removed something ourselves;
    // command-only reclaims report their space to the log, not to `freed`.
    let mut label = format!("{} {} ({}/{})", r.verb, r.current, r.done, r.total);
    if r.freed > 0 {
        label.push_str(&format!(" · freed ~{}", human_size(r.freed)));
    }
    let gauge = Gauge::default()
        .gauge_style(Style::default().fg(ACTIVE).bg(Color::Black))
        .ratio(ratio)
        .label(label);
    frame.render_widget(gauge, area);
}

fn render_status(frame: &mut Frame, area: Rect, app: &App) {
    let line = match &app.mode {
        Mode::Confirm { summary, .. } => Line::from(vec![Span::styled(
            summary.clone(),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )]),
        _ => Line::from(vec![Span::raw(app.message.clone())]),
    };
    frame.render_widget(Paragraph::new(line), area);
}

fn render_help(frame: &mut Frame, view: View) {
    let area = centered(frame.area(), 62, 60);
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE))
        .title(" moosebroom — keys ");
    let text = match view {
        View::Reclaim => vec![
            Line::from("  RECLAIM view"),
            Line::from(""),
            Line::from("  j / k · ↓ ↑      move           g / G      top / bottom"),
            Line::from("  Space            toggle mark     a          mark all unlocked"),
            Line::from("  c / Enter        reclaim marked  Esc        clear marks"),
            Line::from("  s                disk scan       R          rescan"),
            Line::from(""),
            Line::from("  locked rows have nothing to reclaim or need sudo (dimmed)."),
            Line::from("  ? closes this help · q quits"),
        ],
        View::Disk => vec![
            Line::from("  DISK SCAN view (ncdu-style)"),
            Line::from(""),
            Line::from("  j / k · ↓ ↑      move           g / G      top / bottom"),
            Line::from("  l / Enter        enter dir       h / ⌫      up a dir"),
            Line::from("  d                delete hovered  R          rescan cwd"),
            Line::from("  s / Esc          back to reclaim"),
            Line::from(""),
            Line::from("  sizes are full recursive; \"…\" means still computing."),
            Line::from("  ? closes this help · q quits"),
        ],
    };
    let para = Paragraph::new(text)
        .block(block)
        .wrap(Wrap { trim: false })
        .alignment(Alignment::Left);
    frame.render_widget(para, area);
}

fn centered(area: Rect, pct_x: u16, pct_y: u16) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - pct_y) / 2),
            Constraint::Percentage(pct_y),
            Constraint::Percentage((100 - pct_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - pct_x) / 2),
            Constraint::Percentage(pct_x),
            Constraint::Percentage((100 - pct_x) / 2),
        ])
        .split(v[1])[1]
}
