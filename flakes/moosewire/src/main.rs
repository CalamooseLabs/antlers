//! moosewire — a dual-pane TUI that copies files between the local machine and a
//! remote host over SSH/SCP. Left pane = local, right pane = remote. One
//! ControlMaster connection (one Yubikey touch) backs every listing and copy.
//!
//! Usage:
//!   moosewire                 pick a host from the baked list, then open the TUI
//!   moosewire <name|user@host[:port]>   connect to that target and open the TUI
//!   moosewire ls <target> [path]        non-interactive remote listing (smoke test)
//!   moosewire --version | --help

mod app;
mod config;
mod local;
mod model;
mod pane;
mod session;
mod transfer;
mod ui;

use std::io::{stdin, stdout, Write};

use ratatui::crossterm::event::{self, Event, KeyEventKind};

fn main() {
    std::process::exit(real_main());
}

fn real_main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("moosewire {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        return 0;
    }

    let default_user = config::default_user();
    let hosts = config::load_hosts(&default_user);

    // Non-interactive: `moosewire ls <target> [path]`.
    if args.first().map(String::as_str) == Some("ls") {
        let Some(name) = args.get(1) else {
            eprintln!("usage: moosewire ls <target> [path]");
            return 2;
        };
        let target = config::target_from_arg(name, &hosts, &default_user);
        let path = args.get(2).map(String::as_str);
        return match app::run_ls(&target, path) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("moosewire: {e}");
                1
            }
        };
    }

    // Interactive: optional positional target, else pick from the list.
    let target = match args.iter().find(|a| !a.starts_with('-')) {
        Some(t) => config::target_from_arg(t, &hosts, &default_user),
        None => match pick_host(&hosts, &default_user) {
            Some(t) => t,
            None => {
                eprintln!("moosewire: no host selected");
                return 2;
            }
        },
    };

    let session = match session::Session::open(&target) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("moosewire: {e}");
            return 1;
        }
    };

    match run_tui(session) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("moosewire: {e}");
            1
        }
    }
}

fn pick_host(hosts: &[config::Target], default_user: &str) -> Option<config::Target> {
    if hosts.is_empty() {
        eprint!("host (user@host): ");
        stdout().flush().ok();
        let mut line = String::new();
        stdin().read_line(&mut line).ok()?;
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        return Some(config::target_from_arg(line, hosts, default_user));
    }

    println!("moosewire — pick a host:");
    for (i, t) in hosts.iter().enumerate() {
        println!("  {:>2}) {:<16} {}@{}", i + 1, t.name, t.user, t.host);
    }
    print!("> ");
    stdout().flush().ok();
    let mut line = String::new();
    stdin().read_line(&mut line).ok()?;
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if let Ok(n) = line.parse::<usize>() {
        if (1..=hosts.len()).contains(&n) {
            return Some(hosts[n - 1].clone());
        }
    }
    Some(config::target_from_arg(line, hosts, default_user))
}

fn run_tui(session: session::Session) -> Result<(), String> {
    let mut terminal = ratatui::init();
    let mut app = app::App::new(session);
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut app::App,
) -> Result<(), String> {
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
        "moosewire — dual-pane SSH/SCP file mover (left = local, right = remote)\n\n\
         USAGE:\n\
         \x20 moosewire                       pick a host, then open the TUI\n\
         \x20 moosewire <name|user@host[:port]>   connect and open the TUI\n\
         \x20 moosewire ls <target> [path]    print a remote listing (no TUI)\n\
         \x20 moosewire --version | --help\n\n\
         Hosts come from $XDG_CONFIG_HOME/moosewire/hosts (name / [user@]host / fallback-ip).\n\
         In the TUI press ? for keys. One Yubikey touch opens the connection; copies reuse it."
    );
}
