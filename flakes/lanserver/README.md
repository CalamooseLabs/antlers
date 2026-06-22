# lanserver

A tiny **Deno LAN command server**: it maps HTTP routes you declare in NixOS
config onto shell commands and runs them when those routes are hit, returning
the captured stdout/stderr/exit status as JSON. The point is a no-frills control
plane for a trusted LAN — wire `POST /shutdown` to `shutdown 0`, `GET /wake-nas`
to a wake-on-LAN command, and so on — driven entirely by declarative config, no
app code to write. Vendored from `CalamooseLabs/LanServer`
([CalamooseLabs](https://github.com/CalamooseLabs)) and built in-tree.
The repo (`github:CalamooseLabs/antlers`) exposes it as
`packages.<system>.lanserver` (the `deno compile` binary) and as
`overlays.default.lanserver`; the matching `nixosModules.lanserver` provides
**`services.lanserver`**, whose systemd `ExecStart` is that package.

## Outputs

| Output                       | What it is                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `packages.<system>.lanserver`| the `deno compile` binary (`bin/lanserver`); reads `/etc/lanserver/config.json` |
| `overlays.default.lanserver` | the same package, for `nixpkgs.overlays`                                    |
| `nixosModules.lanserver`     | `services.lanserver` — config, systemd unit (ExecStart = the package above), user, firewall |

## How it works

The binary reads `/etc/lanserver/config.json` (written by the module) at startup,
then `Deno.serve`s on `config.port`, bound to **`0.0.0.0`** (the binary always
binds all interfaces — reachability is gated by the module's firewall options, not
the bind address). On each request it looks for a route whose `path` **and**
`method` both match; no match returns `404 {"error":"Route not found"}`.

For a matching route it parses request data (POST only — `application/json` or
`application/x-www-form-urlencoded`; other methods/bodies yield no data), then:

- **Validates `data` fields** (if the route declares any): each declared key must
  be present (else `400 {"error":"Missing required field: <key>"}`) and, for the
  `"string"` type, must be a string (else `400 {"error":"Field <key> must be a string"}`).
- **Substitutes** the parsed values into each command string — both `$key`
  (word-boundary regex) and `${key}` forms are replaced with the submitted value.
- **Executes** every command string in `command`, in order, each as
  `bash -c "<string>"`. The subprocess inherits the server's own environment;
  request data is *not* injected as env vars (it only reaches commands via the
  `$key`/`${key}` substitution above). stdout/stderr are captured per command.

The response is `{ success, outputs, errors, commands }` JSON — `outputs`/`errors`
are per-command arrays, `commands` is the post-substitution command list — with
status **200** when every command exited `0`, **500** otherwise.

> **Trust model.** Route commands run through `bash -c`, and request data is
> substituted into them, so anyone who can reach a route can run its commands
> with the submitted values interpolated. This
> is a deliberately unauthenticated tool for a **trusted LAN** — there is no login,
> token, or per-route auth. Restrict reachability with `localNetworkOnly` (below)
> and keep commands narrow; don't expose it to untrusted networks.

## `services.lanserver` options

| Option                  | Default                                          | Notes                                                                                   |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `enable`                | `false`                                          | run the LAN command server                                                              |
| `port`                  | `8080`                                           | TCP port to listen on (binary always binds `0.0.0.0`)                                    |
| `runAsRoot`             | `false`                                          | run the service as `root:root` (also puts `sudo` on the unit's `PATH`). `false` → a dedicated `lanserver` system user/group and a hardened unit (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem = strict`, `ProtectHome`, `ReadWritePaths = ["/tmp"]`) |
| `routes`                | `[]`                                             | list of route submodules (see below) baked into `/etc/lanserver/config.json`            |
| `localNetworkOnly`      | `false`                                          | firewall scope: `false` opens `port` to everyone (`allowedTCPPorts`); `true` instead adds per-subnet `iptables` accept rules so only `localNetworkSubnets` reach `port` |
| `localNetworkSubnets`   | `["192.168.0.0/16" "10.0.0.0/8" "172.16.0.0/12"]`| IPv4 subnets allowed when `localNetworkOnly` (RFC1918)                                   |
| `enableNixLd`           | `true`                                           | enable `programs.nix-ld` (with `stdenv.cc.cc.lib`, `glibc`, `zlib`, `openssl`) so the unpatched `deno compile` ELF runs |

### `routes.*` (per-route submodule)

| Option    | Default | Notes                                                                                              |
| --------- | ------- | -------------------------------------------------------------------------------------------------- |
| `path`    | (required) | HTTP path to match, e.g. `"/shutdown"`                                                           |
| `method`  | `"GET"` | one of `GET` / `POST` / `PUT` / `DELETE`; matched together with `path`                              |
| `command` | (required) | list of command strings, each run as `bash -c "<string>"` in order; failure of any → 500          |
| `data`    | `null`  | attrset of expected POST fields `name → type` (e.g. `{ serviceName = "string"; }`); each must be present, and `"string"` fields must be strings, or the request is rejected `400`. Field values are substituted into `command` as `$name`/`${name}` |

> The unit's `PATH` is `/run/current-system/sw/{bin,sbin}` plus `bash`, `coreutils`,
> `systemd`, `util-linux` (and `sudo` when `runAsRoot`). Commands needing other
> binaries should reference them by absolute store path or ensure they're in
> `environment.systemPackages`.

## Usage example

Import the module as a flake input and declare a couple of routes:

```nix
{ inputs, ... }:
{
  imports = [ inputs.antlers.nixosModules.lanserver ];

  services.lanserver = {
    enable = true;
    port = 8080;
    localNetworkOnly = true;            # only LAN subnets reach the port
    # localNetworkSubnets = [ "10.10.10.0/24" ];   # narrow it further if you like

    routes = [
      {
        path = "/wake-nas";
        method = "GET";
        command = [ "wakeonlan AA:BB:CC:DD:EE:FF" ];
      }
      {
        path = "/restart-service";
        method = "POST";
        data = { serviceName = "string"; };          # required POST field
        command = [ "systemctl restart $serviceName" ];   # $serviceName ← request body
      }
    ];
  };
}
```

`inputs.antlers.url = "github:CalamooseLabs/antlers";`. Then
`GET http://<host>:8080/wake-nas` runs the wake command, and
`POST /restart-service` with `{"serviceName":"nginx"}` runs
`systemctl restart nginx`. Either consume `nixosModules.lanserver` as above or add
`inputs.antlers.overlays.default` to `nixpkgs.overlays` and drop
`pkgs.lanserver` into `environment.systemPackages` to run the binary yourself
(it still expects `/etc/lanserver/config.json`).

## Build

```sh
nix build .#lanserver        # → ./result/bin/lanserver
```

`flake.nix` does `pkgs.callPackage ./flakes/lanserver/package.nix {}`, which runs
**`deno compile`** against `app/src/main.ts` for the host triple
(`--allow-read=/etc/lanserver --allow-run --allow-net --allow-env --cached-only`),
using a fixed-output `denoCache` derivation and the matching `denort` runtime zip
(both pinned by hash). `app/src/main.ts` has **no external imports** today, so the
deno-cache step fetches nothing and builds offline under the sandbox (its FOD
output is empty, hash stable); the step is kept so any future dep still builds.
The compiled ELF is left unpatched/unstripped (`dontAutoPatchELF` / `dontStrip`)
and runs at service time under **nix-ld** (enabled by the module's `enableNixLd`).
Supported systems: `x86_64-linux` and `aarch64-linux`.
