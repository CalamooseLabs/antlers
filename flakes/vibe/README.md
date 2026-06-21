# vibe

A configured **Claude Code** launcher: the `vibe` command runs Claude Code
against antlers-pinned settings (model, effort, permissions), leaving your real
`~/.claude` config untouched. Exposed as `nixosModules.vibe` →
**`programs.vibe`**.

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
`[<prefix>-]<repo>-<YYYYMMDD>` — `<repo>` is the basename of the working
directory's git toplevel (cwd fallback, sanitized to `[A-Za-z0-9_-]`), `<YYYYMMDD>`
is today's date, and `<prefix>` comes from `remoteControl.prefix`. E.g. a session
in `/srv/projects/antlers` on 2026-06-20 with `prefix = "work"` →
`work-antlers-20260620`. A positional `vibe --remote-control <name>`, `VIBE_NAME`,
or a configured `remoteControl.name` overrides the auto-generated value.

Runtime env overrides (no rebuild):

| Env var               | Effect                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `VIBE_MODEL`          | override the pinned model for this run                            |
| `VIBE_EFFORT`         | override the pinned effort for this run                           |
| `VIBE_ULTRACODE`      | `1`/`true` enables ultracode for this run (settings.json `ultracode`) |
| `VIBE_REMOTE_CONTROL` | force remote-control mode                                         |
| `VIBE_NAME`           | set the Remote Control session name (overrides the auto-generated name) |
| `VIBE_NAME_PREFIX`    | set the prefix for the auto-generated `<prefix>-<repo>-<YYYYMMDD>` name |
| `VIBE_API_KEY_AUTH`   | keep a stray `ANTHROPIC_API_KEY` (opt out of subscription auth)   |
| `VIBE_NO_REGISTER`    | `1` — don't self-register with a local vibe-server (see below)    |
| `VIBE_SERVER_ENDPOINT`| path to the vibe-server discovery file (default `/run/vibe/endpoint.json`) |

### Showing up in vibe-server

If a [`vibe-server`](../vibe-server) runs on the same host, a `vibe` you start by
hand **self-registers** with it so the session appears in its web UI (listed with
a Diff button; driven, as always, from claude.ai / mobile). It works by reading
the server's discovery file (`/run/vibe/endpoint.json` — URL + token) and POSTing
its name/dir/pid over loopback, heartbeating while it runs and deregistering on
exit. It needs `curl` (bundled) and read access to that file; everything is
best-effort, so with no server present `vibe` behaves exactly as before. Sessions
**spawned by** vibe-server set `VIBE_MANAGED=1` and skip this (they're already
tracked); set `VIBE_NO_REGISTER=1` to opt a manual run out.

## Auth & billing

vibe assumes a **subscription** plan. `subscriptionAuth` (default `true`) makes
the wrapper drop a stray `ANTHROPIC_API_KEY` so a session uses the plan's OAuth
login (from `~/.claude` / `CLAUDE_CONFIG_DIR`) rather than silently billing the
API. For genuine API-key billing, set `programs.vibe.subscriptionAuth = false`
(or `VIBE_API_KEY_AUTH=1`).

1M Opus context (`opus[1m]`, the default `model`) is included on Max/Team; on Pro
it draws usage credits. Use `model = "opus"` for the standard 200K window.

## Reasoning modes

Two independent knobs, both written into the session `settings.json` and delivered
via `--settings` (so they apply to interactive **and** Remote Control sessions).
The remote client at claude.ai / mobile can still change them client-side per
session — these set the session default.

### `effort` → settings.json `effortLevel`

| Value      | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `null`     | unset — leave Claude Code's own default in place (vibe's default)        |
| `"low"`    | least reasoning — fastest, fewest tokens                                |
| `"medium"` | moderate reasoning                                                      |
| `"high"`   | deeper reasoning                                                        |
| `"xhigh"`  | maximum standard reasoning depth                                        |
| `"max"`    | the top `/effort` level                                                 |

> Claude Code documents `effortLevel` in `settings.json` as `low`/`medium`/`high`/`xhigh`.
> `max` is the top interactive `/effort` level and may behave as session-only when
> set this way; for a reliably-persisted "go hard" default prefer `"xhigh"` or
> `ultracode`. Per-run override: `VIBE_EFFORT=<value>`.

### `ultracode` → settings.json `ultracode`

| Value   | Meaning                                                                          |
| ------- | -------------------------------------------------------------------------------- |
| `false` | (default) off                                                                    |
| `true`  | **xhigh effort + dynamic multi-agent workflow orchestration** for substantive tasks |

`ultracode` is a **separate toggle, orthogonal to `effort`** — internally it sends
`xhigh` to the model *and* additionally lets Claude spin up parallel sub-agent
workflows (which uses substantially more tokens). Don't combine it with `effort`
expecting them to stack; `ultracode` already implies `xhigh`. Per-run override:
`VIBE_ULTRACODE=1`.

## Permission mode

The `permissionMode` option sets Claude Code's default approval behavior. vibe
delivers it via the top-level **`claude --permission-mode <mode>` FLAG**, not
settings.json — the flag is the reliable launch-time override (a `defaultMode` in
a `--settings` file is treated as a project/local setting, and `auto` from there
is deliberately ignored). It applies to **both interactive and Remote Control
sessions**. Defaults to **`auto`**. (The `permissions` attrs option still carries
`allow` / `deny` / `ask` rules, which layer on top.)

| Value                 | Behavior                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `"auto"`              | **(default)** auto-execute everything except classifier-blocked actions                            |
| `"default"`           | prompt before any write (edits, Bash, network); reads auto-approved                               |
| `"acceptEdits"`       | auto-approve reads, file edits, and common fs commands (`mkdir`/`touch`/`rm`/`mv`/`cp`/`sed`); other writes still prompt |
| `"plan"`              | read/explore only — Claude proposes a plan and asks before executing                              |
| `"dontAsk"`           | auto-**deny** anything not matching an `allow` rule or read-only Bash; fully non-interactive       |
| `"bypassPermissions"` | skip all prompts and safety checks — **isolated containers/VMs only** (`ask` rules and `rm -rf /`/`~` still prompt) |
| `""`                  | leave unset — Claude Code's own default                                                           |

> **`auto` eligibility:** needs claude-code ≥ 2.1.83 and an eligible model
> (e.g. Opus/Sonnet 4.6+); if the account/model isn't eligible, Claude Code
> silently falls back to `default`. `auto` works in Remote Control sessions
> (claude.ai / mobile).
>
> `bypassPermissions` additionally requires a launch flag
> (`--dangerously-skip-permissions`) and Claude Code refuses to start in it as
> `root`/`sudo` outside a recognized sandbox — relevant under vibe-server's
> `runAsRoot`. In every mode except `bypassPermissions`, writes to protected paths
> (`.git`, `.claude`, shell rc files, …) are never auto-approved.
>
> Per-run override: `VIBE_PERMISSION_MODE=<mode>`.

## `programs.vibe` options

| Option                      | Default      | Notes                                                              |
| --------------------------- | ------------ | ----------------------------------------------------------------- |
| `enable`                    | `false`      | put `vibe` on `PATH`                                              |
| `package`                   | `null`       | override the built launcher (else built from the options below)   |
| `model`                     | `"opus[1m]"` | settings.json `model`; `"opus"` for 200K, `null` to leave unpinned |
| `effort`                    | `null`       | `low`/`medium`/`high`/`xhigh`/`max`                               |
| `ultracode`                 | `false`      | settings.json `ultracode = true` — xhigh effort + dynamic workflow orchestration (separate from `effort`) |
| `permissionMode`            | `"auto"`     | `claude --permission-mode` flag; see [Permission mode](#permission-mode) for values (`""` to leave unset) |
| `permissions`               | `{}`         | Claude Code `permissions` object for `allow`/`deny`/`ask` rules (the mode is set by `permissionMode`) |
| `subscriptionAuth`          | `true`       | drop a stray `ANTHROPIC_API_KEY` (subscription billing)           |
| `remoteControl.enable`/`.name` | `false`/`null` | default to Remote Control mode + an explicit session name (null → auto-generate) |
| `remoteControl.prefix`      | `""`         | prefix for the auto-generated `<prefix>-<repo>-<YYYYMMDD>` session name |
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
    # permissionMode defaults to "auto"; set acceptEdits/plan/etc. to change it.
  };
}
```

Use `lib.<system>.mkVibeWrapper { … }` to build a launcher outside the module.
