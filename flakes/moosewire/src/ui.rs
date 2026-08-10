//! Rendering. Two side-by-side panes, a transfer gauge, a status/prompt line,
//! and a help overlay.

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Gauge, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, Mode, Prompt};
use crate::model::{human_size, human_time, Kind, Side};
use crate::pane::Pane;

const ACTIVE: Color = Color::Cyan;
const DIM: Color = Color::DarkGray;

pub fn draw(frame: &mut Frame, app: &App) {
    let show_gauge = app.transfer.is_some();
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(if show_gauge { 1 } else { 0 }),
            Constraint::Length(1),
        ])
        .split(frame.area());

    let panes = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[0]);

    render_pane(frame, panes[0], &app.local, "LOCAL".to_string(), app.active == Side::Local);
    render_pane(frame, panes[1], &app.remote, app.remote_label(), app.active == Side::Remote);

    if show_gauge {
        render_gauge(frame, rows[1], app);
    }
    render_status(frame, rows[2], app);

    if matches!(app.mode, Mode::Help) {
        render_help(frame);
    }
}

fn render_pane(frame: &mut Frame, area: Rect, pane: &Pane, label: String, active: bool) {
    let border = if active {
        Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(DIM)
    };
    let mut title = format!(" {label} ");
    if !pane.filter.is_empty() {
        title.push_str(&format!("/{} ", pane.filter));
    }
    if !pane.selected.is_empty() {
        title.push_str(&format!("[{} marked] ", pane.selected.len()));
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border)
        .title(title);

    let inner_w = area.width.saturating_sub(2) as usize;
    let items: Vec<ListItem> = pane
        .view
        .iter()
        .map(|e| row(e, pane.selected.contains(&e.name), inner_w))
        .collect();

    let highlight = if active {
        Style::default().bg(ACTIVE).fg(Color::Black).add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::REVERSED)
    };

    let list = List::new(items)
        .block(block)
        .highlight_style(highlight)
        .highlight_symbol("");

    let mut state = ListState::default();
    if !pane.view.is_empty() {
        state.select(Some(pane.cursor));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn row(e: &crate::model::Entry, marked: bool, width: usize) -> ListItem<'static> {
    let mark = if marked { "*" } else { " " };
    let (suffix, color) = match e.kind {
        Kind::Dir => ("/", Color::Blue),
        Kind::Link => ("@", Color::Cyan),
        Kind::Other => ("", Color::Magenta),
        Kind::File => ("", Color::Reset),
    };
    let name = format!("{}{}", e.name, suffix);
    let meta = if e.name == ".." {
        String::new()
    } else if e.kind.is_dir() {
        human_time(e.mtime)
    } else {
        format!("{}  {}", human_size(e.size), human_time(e.mtime))
    };

    // Left: mark + name; right: metadata, space-padded to `width`.
    let left_len = 1 + 1 + name.chars().count(); // mark + space + name
    let pad = width.saturating_sub(left_len + meta.chars().count());
    let name_style = if marked {
        Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(color)
    };
    let line = Line::from(vec![
        Span::styled(mark.to_string(), Style::default().fg(Color::Yellow)),
        Span::raw(" "),
        Span::styled(name, name_style),
        Span::raw(" ".repeat(pad)),
        Span::styled(meta, Style::default().fg(DIM)),
    ]);
    ListItem::new(line)
}

fn render_gauge(frame: &mut Frame, area: Rect, app: &App) {
    let t = app.transfer.as_ref().unwrap();
    let ratio = t.ratio();
    // Byte-level "45%  1.2G / 2.7G  ·  12M/s  ·  ETA 2:04" when the job could be
    // sized; otherwise fall back to the item count.
    let mut label = if t.total_bytes > 0 {
        format!(
            "{} {}  {:.0}%  {} / {}",
            t.verb,
            t.current,
            ratio * 100.0,
            human_size(t.bytes_done),
            human_size(t.total_bytes),
        )
    } else {
        format!("{} {} ({}/{})", t.verb, t.current, t.done, t.total)
    };
    if t.rate > 1.0 {
        label.push_str(&format!("  ·  {}/s", human_size(t.rate as u64)));
    }
    if let Some(eta) = t.eta_secs() {
        label.push_str(&format!("  ·  ETA {}", hms(eta)));
    }
    let gauge = Gauge::default()
        .gauge_style(Style::default().fg(ACTIVE).bg(Color::Black))
        .ratio(ratio)
        .label(label);
    frame.render_widget(gauge, area);
}

/// Format a duration in seconds as `M:SS` (or `H:MM:SS` past an hour).
fn hms(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

fn render_status(frame: &mut Frame, area: Rect, app: &App) {
    let line = match &app.mode {
        Mode::Filter => Line::from(vec![
            Span::styled("/", Style::default().fg(ACTIVE)),
            Span::raw(app.input.clone()),
            Span::styled("█", Style::default().fg(ACTIVE)),
        ]),
        Mode::Prompt(p) => {
            let prefix = match p {
                Prompt::Mkdir => "new dir: ",
                Prompt::Rename(_) => "rename to: ",
            };
            Line::from(vec![
                Span::styled(prefix, Style::default().fg(ACTIVE).add_modifier(Modifier::BOLD)),
                Span::raw(app.input.clone()),
                Span::styled("█", Style::default().fg(ACTIVE)),
            ])
        }
        Mode::Confirm(paths) => Line::from(vec![Span::styled(
            format!("delete {} item(s)? [y/N]", paths.len()),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )]),
        _ => {
            let mut spans = vec![Span::raw(app.message.clone())];
            if let Some(clip) = app.clip_summary() {
                spans.push(Span::raw("   "));
                spans.push(Span::styled(clip, Style::default().fg(Color::Yellow)));
            }
            Line::from(spans)
        }
    };
    frame.render_widget(Paragraph::new(line), area);
}

fn render_help(frame: &mut Frame) {
    let area = centered(frame.area(), 60, 60);
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACTIVE))
        .title(" moosewire — keys ");
    let text = vec![
        Line::from("  j / k · ↓ ↑      move          Tab        switch pane"),
        Line::from("  l / Enter        enter dir      h / ⌫      up a dir"),
        Line::from("  g / G            top / bottom   Ctrl-d/u   half page"),
        Line::from("  Space            mark           .          toggle hidden"),
        Line::from("  /                filter         R          refresh both"),
        Line::from(""),
        Line::from("  y                yank (copy)    x          yank (cut/move)"),
        Line::from("  p                paste → other pane's dir  (local↔remote)"),
        Line::from("  a                new dir        r          rename"),
        Line::from("  d                delete         Esc        clear marks/yank"),
        Line::from(""),
        Line::from("  yank on one side, Tab to the other pane, paste to transfer."),
        Line::from("  ? closes this help · q quits"),
    ];
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
