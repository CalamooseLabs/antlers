# vibe

A configured **Claude Code** launcher: the `vibe` command runs Claude Code
against antlers-pinned settings (model, effort, permissions), leaving your real
`~/.claude` config untouched. Exposed as `nixosModules.vibe` →
**`programs.vibe`**.

> Looking for the browser-based session manager? That's a separate module,
> [`nixosModules.vibe-server`](../vibe-server/README.md) → `services.vibe`. It
> spawns `vibe` sessions you drive from claude.ai / mobile. Import both to run
> the service with sessions launched by your configured `vibe`.

Subscription-first: vibe targets Claude Code **Max / Team / Pro** plans (OAuth
login), not API pay-as-you-go. See [`Auth & billing`](#auth--billing).

## Outputs

| Output                          | What it is                                                                 |
| ------------------------------- | ------------------------------------------------------------------------- |
| `lib.<system>.mkVibeWrapper`    | builder: `cfg → writeShellApplication "vibe"` (the zed-editor wrapper pattern) |
| `packages.<system>.vibe`        | the above with default config (ready to run)                              |
| `nixosModules.vibe`             | `programs.vibe` — installs the `vibe` launcher system-wide                 |

## The `vibe` command

```sh
vibe                       # interactive Claude Code with the pinned settings
vibe --remote-control [name]   # same, with Remote Control enabled (drive from claude.ai / mobile)
vibe --help                # usage + the pinned settings + `claude auth status`
vibe --show-config         # print the pinned settings.json and exit
```

Both modes run `claude --settings <generated>`; remote control just adds the
top-level **`--remote-control` flag** (not the `claude remote-control`
subcommand, which can't take `--settings`), so the pinned model/effort/permissions
apply to remote-control sessions too.

**Remote Control session name.** With no explicit name, vibe auto-generates
`[<prefix>-]<repo>-<YYMMDD>` — `<repo>` is the basename of the working
directory's git toplevel (cwd fallback, sanitized to `[A-Za-z0-9_-]`), `<YYMMDD>`
is today's date, and `<prefix>` comes from `remoteControl.prefix`. E.g. a session
in `/srv/projects/antlers` on 2026-06-20 with `prefix = "work"` →
`work-antlers-260620`. A positional `vibe --remote-control <name>`, `VIBE_NAME`,
or a configured `remoteControl.name` overrides the auto-generated value.

Runtime env overrides (no rebuild):

| Env var               | Effect                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `VIBE_MODEL`          | override the pinned model for this run                            |
| `VIBE_EFFORT`         | override the pinned effort for this run                           |
| `VIBE_REMOTE_CONTROL` | force remote-control mode                                         |
| `VIBE_NAME`           | set the Remote Control session name (overrides the auto-generated name) |
| `VIBE_NAME_PREFIX`    | set the prefix for the auto-generated `<prefix>-<repo>-<YYMMDD>` name |
| `VIBE_API_KEY_AUTH`   | keep a stray `ANTHROPIC_API_KEY` (opt out of subscription auth)   |

## Auth & billing

vibe assumes a **subscription** plan. `subscriptionAuth` (default `true`) makes
the wrapper drop a stray `ANTHROPIC_API_KEY` so a session uses the plan's OAuth
login (from `~/.claude` / `CLAUDE_CONFIG_DIR`) rather than silently billing the
API. For genuine API-key billing, set `programs.vibe.subscriptionAuth = false`
(or `VIBE_API_KEY_AUTH=1`).

1M Opus context (`opus[1m]`, the default `model`) is included on Max/Team; on Pro
it draws usage credits. Use `model = "opus"` for the standard 200K window.

## `programs.vibe` options

| Option                      | Default      | Notes                                                              |
| --------------------------- | ------------ | ----------------------------------------------------------------- |
| `enable`                    | `false`      | put `vibe` on `PATH`                                              |
| `package`                   | `null`       | override the built launcher (else built from the options below)   |
| `model`                     | `"opus[1m]"` | settings.json `model`; `"opus"` for 200K, `null` to leave unpinned |
| `effort`                    | `null`       | `low`/`medium`/`high`/`xhigh`/`max`                               |
| `permissions`               | `{}`         | Claude Code `permissions` object (delivered via `--settings`)     |
| `subscriptionAuth`          | `true`       | drop a stray `ANTHROPIC_API_KEY` (subscription billing)           |
| `remoteControl.enable`/`.name` | `false`/`null` | default to Remote Control mode + an explicit session name (null → auto-generate) |
| `remoteControl.prefix`      | `""`         | prefix for the auto-generated `<prefix>-<repo>-<YYMMDD>` session name |
| `extraSettings`             | `{}`         | merged into the generated settings.json                          |
| `extraArgs`                 | `[]`         | appended to every `claude` invocation                            |

Example — install the `vibe` launcher system-wide, pinned to your plan's model:

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.vibe ];

  programs.vibe = {
    enable = true;                              # put `vibe` on PATH
    model = "opus[1m]";                         # latest Opus + 1M context
    effort = "high";
    remoteControl = { enable = true; name = "workstation"; };
    permissions.defaultMode = "acceptEdits";
  };
}
```

Use `lib.<system>.mkVibeWrapper { … }` to build a launcher outside the module.

These pins also flow to the web session manager: when you import
[`nixosModules.vibe-server`](../vibe-server/README.md) alongside this module, its
sessions default to the `programs.vibe` launcher (so they honour the same
model/effort/permissions).
