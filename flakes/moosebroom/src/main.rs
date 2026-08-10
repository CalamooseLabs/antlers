//! moosebroom — a TUI that finds and reclaims wasted disk space: Nix
//! generations/GC/store-optimise, ~/.cache and other junk, dev/container caches,
//! plus an ncdu-style disk scan. Two views toggled with `s`. Every destructive
//! action is a `model::Step` executed only by the reclaim worker.
//!
//! Usage:
//!   moosebroom                open the TUI in the reclaim view
//!   moosebroom scan [PATH]    open the TUI in disk-scan mode at PATH ($HOME)
//!   moosebroom report         print the reclaim targets, no TUI (smoke test)
//!   moosebroom --version | --help

mod app;
mod du;
mod model;
mod probe;
mod reclaim;
mod ui;

use std::path::PathBuf;

use ratatui::crossterm::event::{self, Event, KeyEventKind};

use app::{App, View};

fn main() {
    std::process::exit(real_main());
}

fn real_main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("moosebroom {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        return 0;
    }

    match args.first().map(String::as_str) {
        // Non-interactive report: probe and print, no TUI, no destructive steps.
        Some("report") => app::run_report(),
        // Open straight into the disk scan at an optional path (default $HOME).
        Some("scan") => {
            let root = args
                .get(1)
                .map(PathBuf::from)
                .unwrap_or_else(model::home);
            run_tui(View::Disk, root)
        }
        // Bare invocation → the reclaim view.
        None => run_tui(View::Reclaim, model::home()),
        Some(other) => {
            eprintln!("moosebroom: unknown command '{other}'");
            print_usage();
            2
        }
    }
}

fn run_tui(view: View, scan_root: PathBuf) -> i32 {
    let mut terminal = ratatui::init();
    let mut app = App::new(view, scan_root);
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("moosebroom: {e}");
            1
        }
    }
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<(), String> {
    loop {
        terminal
            .draw(|frame| ui::draw(frame, app))
            .map_err(|e| e.to_string())?;

        app.tick();

        if event::poll(app::TICK).map_err(|e| e.to_string())? {
            if let Event::Key(key) = event::read().map_err(|e| e.to_string())? {
                if key.kind == KeyEventKind::Press {
                    app.on_key(key);
                }
            }
        }

        if app.should_quit {
            return Ok(());
        }
    }
}

fn print_usage() {
    println!(
        "moosebroom — find and reclaim wasted disk space (Nix, caches, dev junk, disk scan)\n\n\
         USAGE:\n\
         \x20 moosebroom                 open the TUI in the reclaim view\n\
         \x20 moosebroom scan [PATH]     open the TUI in disk-scan mode at PATH (default $HOME)\n\
         \x20 moosebroom report          print the reclaim targets, no TUI (read-only)\n\
         \x20 moosebroom --version | --help\n\n\
         In the TUI press ? for keys. s toggles reclaim ↔ disk scan. Nothing is\n\
         deleted without an explicit y confirm. Root-only targets need sudo."
    );
}
