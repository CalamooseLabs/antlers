# cala-installer — auto-running gum TUI front-end for the Cala-M-OS installer.
#
# Launched automatically on the installer ISO's tty1 (see cala-m-os
# iso/default.nix). It is a THIN front-end: it waits for network, offers
# read-only hardware inspection, walks host + machine selection (including a
# freshly-generated "self" config for arbitrary hardware), and — for hosts that
# resolve to the online (Proton Pass) secrets backend — prompts for a
# `proton-secrets login` + PAT and seeds them onto the target. It then hands off
# to the proven, unchanged `install-cala-m-os` backend, which performs the
# destructive disko/format/install passes.
#
# Convention (matches the other antlers scripts): every previously-hardcoded
# value is read from an env var with the original default. Inspection tools (gum,
# lspci, lsusb, dmidecode, lshw, nvme, ip, lsblk) are baked as runtimeInputs;
# system tools that live on the ISO (install-cala-m-os, proton-secrets, disko,
# nixos-generate-config, nmtui, nm-online) resolve from the inherited $PATH,
# exactly as install-cala-m-os already resolves disko/nixos-install.

# ---------------------------------------------------------------------------
# Config (env-var-with-defaults)
# ---------------------------------------------------------------------------
FLAKE_REF="${INSTALL_FLAKE_REF:-github:CalamooseLabs/cala-m-os}"
CLONE_URL="${INSTALL_CLONE_URL:-https://github.com/calamooselabs/cala-m-os.git}"
# Working clone used only by the generate-fresh (self) path.
SELF_CLONE_DIR="${CALA_SELF_CLONE_DIR:-/root/cala-m-os-self}"
# Proton Pass session store (must match services.proton-secrets.sessionDir).
PROTON_SESSION_DIR="${PROTON_PASS_SESSION_DIR:-/var/lib/proton-pass-cli}"
export PROTON_PASS_SESSION_DIR="$PROTON_SESSION_DIR"
export PROTON_PASS_KEY_PROVIDER="${PROTON_PASS_KEY_PROVIDER:-fs}"

# Always revalidate upstream freshness (matches install-cala-m-os): the version
# read + backend eval below then resolve the current default-branch HEAD.
export NIX_CONFIG="tarball-ttl = 0"

# Host + machine lists — kept in sync with install-cala-m-os.completion.bash.
CALA_HOSTS=(ai lanstation devbox ephemeral homelab simple battlestation broadcast openreturn livedata)
CALA_MACHINES=(A520M-ITX B760-PLUS B850-MAX FW13-11XXP FW13-12XXP FW16-AMD-AI MS-01 MS-02 TRX50-SAGE ZIMA X-Small Small Medium Large)

# Selection state, filled as we go.
HOST=""
MACHINE=""
USE_SELF=0
SELF_FLAKE_REF=""
PROTON_DO_SEED=0
PROTON_PAT=""

# ---------------------------------------------------------------------------
# Small UI helpers (info/warn/die render to stderr so they never pollute a
# value captured via $(...) inside a helper).
# ---------------------------------------------------------------------------
info() { gum style --foreground 4 "• $*" >&2; }
warn() { gum style --foreground 3 "! $*" >&2; }
die()  { gum style --foreground 1 "✗ $*" >&2; exit 1; }

banner() {
  printf '\033c' 2>/dev/null || true
  gum style --border double --padding "1 3" --margin "1 0" --foreground 6 \
    "Cala-M-OS Installer" "$(uname -srm)"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
net_up() {
  # Prefer NetworkManager's own readiness check when present…
  if command -v nm-online >/dev/null 2>&1 && nm-online -q -t 5 2>/dev/null; then
    return 0
  fi
  # …otherwise a dependency-free reachability probe (bash /dev/tcp builtin).
  timeout 5 bash -c 'exec 3<>/dev/tcp/github.com/443' 2>/dev/null
}

wait_for_network() {
  local tries=0
  while ! net_up; do
    tries=$((tries + 1))
    warn "No network connection detected yet."
    local choice=""
    choice=$(gum choose --header "Network is required to fetch the config:" \
      "Configure with nmtui" \
      "Retry" \
      "Continue offline (installs will likely fail)" \
      "Drop to a shell" || true)
    case "$choice" in
      "Configure with nmtui")
        if command -v nmtui >/dev/null 2>&1; then nmtui; else warn "nmtui unavailable."; fi
        ;;
      "Retry") : ;;
      "Continue offline"*) warn "Continuing without network."; return 0 ;;
      "Drop to a shell" | "") exit 0 ;;
    esac
    if [ "$tries" -ge 15 ]; then
      warn "Giving up automatic waiting."
      return 0
    fi
  done
  info "Network is up."
}

# ---------------------------------------------------------------------------
# Read-only hardware inspection
# ---------------------------------------------------------------------------
inspect_hardware() {
  while true; do
    local choice=""
    choice=$(gum choose --header "Inspect hardware (read-only):" \
      "PCI devices (lspci)" \
      "USB devices (lsusb)" \
      "Block devices (lsblk)" \
      "NVMe drives (nvme list)" \
      "Network interfaces (ip)" \
      "System / baseboard (dmidecode)" \
      "Hardware summary (lshw)" \
      "← Back" || true)
    case "$choice" in
      "PCI devices"*)     { lspci 2>&1 || true; } | gum pager ;;
      "USB devices"*)     { lsusb 2>&1 || true; } | gum pager ;;
      "Block devices"*)   { lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL 2>&1 || true; } | gum pager ;;
      "NVMe drives"*)     { nvme list 2>&1 || true; } | gum pager ;;
      "Network"*)         { ip -br addr 2>&1 || true; } | gum pager ;;
      "System"*)          { dmidecode -t system -t baseboard 2>&1 || true; } | gum pager ;;
      "Hardware summary"*) { lshw -short 2>&1 || true; } | gum pager ;;
      "← Back" | "") return 0 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Top menu
# ---------------------------------------------------------------------------
top_menu() {
  while true; do
    local choice=""
    choice=$(gum choose --header "What would you like to do?" \
      "Install Cala-M-OS" \
      "Inspect hardware" \
      "Drop to a shell" || true)
    case "$choice" in
      "Install Cala-M-OS") return 0 ;;
      "Inspect hardware")  inspect_hardware ;;
      "Drop to a shell" | "") exit 0 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Host + machine selection
# ---------------------------------------------------------------------------
pick_host() {
  HOST=$(gum choose --header "Select the host to install:" "${CALA_HOSTS[@]}" || true)
  [ -n "$HOST" ] || return 1
}

# Match DMI identifiers to a predefined machine. Returns a machine name on stdout,
# or nothing. Explicit overrides first (add your boards here), then a fuzzy
# contains-match of the machine name against the DMI strings.
dmi_match() {
  local board="$1" product="$2" family="$3"
  local hay="${board} ${product} ${family}"
  local up="${hay^^}"

  # --- Explicit overrides (extend as boards are identified) ---------------
  # Framework codenames etc. don't contain the machine dir name, so map them
  # here. Example (verify the codename against your box's board_name first):
  #   case "$up" in *FRANMHCP*) echo "FW16-AMD-AI"; return 0 ;; esac

  # --- Fuzzy: physical-board machine name appears in the DMI strings ------
  local m
  for m in "${CALA_MACHINES[@]}"; do
    case "$m" in
      X-Small | Small | Medium | Large) continue ;; # VM sizes, not physical boards
    esac
    if [[ "$up" == *"${m^^}"* ]]; then
      echo "$m"
      return 0
    fi
  done
  return 0
}

machine_autodetect() {
  local board product family vendor
  board=$(cat /sys/class/dmi/id/board_name 2>/dev/null || true)
  product=$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)
  family=$(cat /sys/class/dmi/id/product_family 2>/dev/null || true)
  vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)

  local guess=""
  guess=$(dmi_match "$board" "$product" "$family")

  if [ -n "$guess" ]; then
    info "Detected: ${vendor:-?} / ${product:-?} / board ${board:-?}"
    if gum confirm "Use predefined machine '$guess'?"; then
      MACHINE="$guess"
      return 0
    fi
  else
    warn "No machine matched this box."
    warn "DMI  vendor='${vendor}'  product='${product}'  family='${family}'  board='${board}'"
    info "Add a mapping in dmi_match(), or pick manually below."
  fi
  MACHINE=$(gum choose --header "Pick a machine (Esc for the host default):" "${CALA_MACHINES[@]}" || true)
}

pick_machine() {
  MACHINE=""
  USE_SELF=0
  local choice=""
  choice=$(gum choose --header "Machine profile for '$HOST':" \
    "Auto-detect this machine" \
    "Generate a fresh config for THIS box (self)" \
    "Pick a predefined machine" \
    "Use the host's default machine" || true)
  case "$choice" in
    "Auto-detect"*) machine_autodetect ;;
    "Generate"*)    prepare_self || die "Failed to prepare a self config." ;;
    "Pick"*)        MACHINE=$(gum choose --header "Predefined machine:" "${CALA_MACHINES[@]}" || true) ;;
    "Use the host"* | "") MACHINE="" ;;
  esac
}

# ---------------------------------------------------------------------------
# Generate-fresh (self) machine profile
# ---------------------------------------------------------------------------

# Pick a whole disk to install onto, excluding the live installer medium.
# Echoes the chosen /dev path on stdout.
pick_disk() {
  local iso_src="" iso_disk=""
  iso_src=$(findmnt -n -o SOURCE /iso 2>/dev/null || true)
  [ -n "$iso_src" ] || iso_src=$(findmnt -n -o SOURCE /nix/.ro-store 2>/dev/null || true)
  if [ -n "$iso_src" ]; then
    local pk=""
    pk=$(lsblk -no PKNAME "$iso_src" 2>/dev/null | head -1 || true)
    [ -n "$pk" ] && iso_disk="/dev/$pk"
  fi

  local -a entries=()
  local name size type model
  while read -r name size type model; do
    [[ "$type" == "disk" ]] || continue
    [[ -n "$iso_disk" && "$name" == "$iso_disk" ]] && continue
    entries+=("$name  ($size)  ${model:-disk}")
  done < <(lsblk -dpno NAME,SIZE,TYPE,MODEL 2>/dev/null)

  if [ "${#entries[@]}" -eq 0 ]; then
    warn "No installable disks found (only the live medium?)."
    return 1
  fi

  local pick=""
  pick=$(gum choose --header "Target disk — WILL BE ERASED:" "${entries[@]}" || true)
  [ -n "$pick" ] || return 1
  local dev="${pick%%  *}" # first field, up to the double space
  if gum confirm "ERASE $pick? All data on $dev is destroyed."; then
    echo "$dev"
    return 0
  fi
  return 1
}

write_self_disko() {
  local out="$1" dev="$2"
  cat >"$out" <<EOF
# Generated by cala-installer for this box. Generic single-disk GPT layout:
# ESP + ext4 root + swap (resume). Edit before rebuilding for anything fancier.
{
  disko.devices.disk.main = {
    device = "$dev";
    type = "disk";
    content = {
      type = "gpt";
      partitions = {
        ESP = {
          size = "512M";
          type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
            mountOptions = ["umask=0077"];
          };
        };
        root = {
          end = "-8G";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
        swap = {
          size = "100%";
          content = {
            type = "swap";
            discardPolicy = "both";
            resumeDevice = true;
          };
        };
      };
    };
  };
}
EOF
}

write_self_configuration() {
  cat >"$1" <<'EOF'
# Generated by cala-installer — self machine profile for this specific box.
{pkgs, ...}: {
  imports = [
    ./hardware-configuration.nix
    ./disko.nix
  ];

  boot.kernelPackages = pkgs.linuxPackages_latest;
}
EOF
}

prepare_self() {
  info "Generating a fresh machine config for this box."

  local disk=""
  disk=$(pick_disk) || return 1

  rm -rf "$SELF_CLONE_DIR"
  if ! gum spin --title "Cloning the config…" -- git clone "$CLONE_URL" "$SELF_CLONE_DIR"; then
    die "git clone of $CLONE_URL failed."
  fi

  local selfdir="$SELF_CLONE_DIR/machines/workstations/self"
  mkdir -p "$selfdir"

  # Hardware only — disko owns fileSystems, so --no-filesystems is essential.
  if ! gum spin --title "Detecting hardware…" -- nixos-generate-config --no-filesystems --dir "$selfdir"; then
    die "nixos-generate-config failed."
  fi
  # nixos-generate-config also drops a configuration.nix; we write our own.
  rm -f "$selfdir/configuration.nix"

  write_self_disko "$selfdir/disko.nix" "$disk"
  write_self_configuration "$selfdir/configuration.nix"
  printf '{...}: {\n}\n' >"$selfdir/home.nix"

  # COMMIT so `git clone` carries the files and the flake eval (git tree) sees
  # them — Nix ignores untracked files even under --impure.
  git -C "$SELF_CLONE_DIR" add machines/workstations/self >/dev/null
  git -C "$SELF_CLONE_DIR" \
    -c user.name=cala-installer -c user.email=installer@calamoose \
    commit -q -m "self: generated machine profile for this box" >/dev/null

  MACHINE="self"
  USE_SELF=1
  SELF_FLAKE_REF="$SELF_CLONE_DIR"
  info "Self config written to machines/workstations/self and committed."
}

# ---------------------------------------------------------------------------
# Online (Proton Pass) secrets
# ---------------------------------------------------------------------------
detect_backend() {
  nix eval --raw --impure \
    "$1#nixosConfigurations.$HOST.config.calamoose._secretsBackend" 2>/dev/null || echo "none"
}

# Look for a pre-provisioned PAT before prompting: an explicit PROTON_PASS_PAT_FILE,
# then a filesystem labeled CALAPAT (written by `flash-iso --with-pat` onto the boot
# stick). Echoes the PAT on stdout if found.
discover_pat() {
  if [ -n "${PROTON_PASS_PAT_FILE:-}" ] && [ -r "${PROTON_PASS_PAT_FILE}" ]; then
    cat "${PROTON_PASS_PAT_FILE}"
    return 0
  fi
  local dev=""
  if [ -e /dev/disk/by-label/CALAPAT ]; then
    dev=$(readlink -f /dev/disk/by-label/CALAPAT 2>/dev/null || true)
  elif command -v blkid >/dev/null 2>&1; then
    dev=$(blkid -L CALAPAT 2>/dev/null || true)
  fi
  [ -n "$dev" ] || return 1
  local mp=""
  mp=$(mktemp -d)
  local pat=""
  if mount -o ro "$dev" "$mp" 2>/dev/null; then
    [ -r "$mp/pat" ] && pat=$(cat "$mp/pat")
    umount "$mp" 2>/dev/null || true
  fi
  rmdir "$mp" 2>/dev/null || true
  [ -n "$pat" ] || return 1
  printf '%s' "$pat"
}

proton_flow() {
  PROTON_DO_SEED=0
  PROTON_PAT=""

  # Non-interactive path: a PAT pre-provisioned on the media (flash-iso --with-pat)
  # or via PROTON_PASS_PAT_FILE. Verify it mints a session, then skip the prompts.
  local auto_pat=""
  auto_pat=$(discover_pat || true)
  if [ -n "$auto_pat" ]; then
    info "Found a pre-provisioned Proton Pass PAT — using it (no prompt)."
    PROTON_PAT="$auto_pat"
    PROTON_DO_SEED=1
    if PROTON_PASS_PERSONAL_ACCESS_TOKEN="$auto_pat" proton-secrets login >/dev/null 2>&1 &&
      proton-secrets status >/dev/null 2>&1; then
      info "PAT established a live Proton Pass session."
    else
      warn "The provisioned PAT did not establish a session — it will still be seeded; verify it is valid."
    fi
    return 0
  fi

  gum style --border rounded --padding "1 2" --margin "1 0" --foreground 5 \
    "Host '$HOST' uses ONLINE secrets (Proton Pass)." \
    "Set up a session + Personal Access Token so first boot can fetch them."

  if gum confirm "Log in to Proton Pass now?"; then
    proton-secrets login || warn "proton-secrets login did not complete."
    if proton-secrets status >/dev/null 2>&1; then
      info "Proton Pass session established."
      PROTON_DO_SEED=1
    else
      warn "No live Proton session after login."
    fi
  fi

  if gum confirm "Provide a Personal Access Token (PAT) for reliable first-boot fetch? (recommended)"; then
    PROTON_PAT=$(gum input --password --placeholder "pst_...::key" || true)
    [ -n "$PROTON_PAT" ] && PROTON_DO_SEED=1
  fi

  if [ "$PROTON_DO_SEED" -eq 0 ]; then
    warn "No Proton session or PAT captured."
    warn "The install will continue, but the FIRST-BOOT secret fetch will fail closed."
    warn "Recover after boot with:  sudo proton-secrets login"
    gum confirm "Continue anyway?" || return 1
  fi
  return 0
}

# Seed the captured session + PAT onto the freshly installed target (/mnt is
# still mounted after the backend returns). tmpfiles' `d` rule is non-destructive
# to these pre-seeded contents.
seed_proton_target() {
  [ "$PROTON_DO_SEED" -eq 1 ] || return 0
  local tgt="/mnt/var/lib/proton-pass-cli"
  install -d -m 700 "$tgt"

  if [ -d "$PROTON_SESSION_DIR" ]; then
    cp -a "$PROTON_SESSION_DIR/." "$tgt/" 2>/dev/null || true
    info "Copied the Proton session onto the target (best-effort)."
  fi

  if [ -n "$PROTON_PAT" ]; then
    (umask 077; printf '%s' "$PROTON_PAT" >"$tgt/pat")
    chmod 600 "$tgt/pat"
    info "Seeded PAT to /var/lib/proton-pass-cli/pat on the target."
    warn "Remember: the host must set services.proton-secrets.patFile ="
    warn "  \"/var/lib/proton-pass-cli/pat\" and persist /var/lib/proton-pass-cli."
  fi

  chown -R root:root "$tgt" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  command -v gum >/dev/null 2>&1 || { echo "cala-installer: gum is required" >&2; exit 1; }

  banner
  wait_for_network
  top_menu

  pick_host || die "No host selected."
  pick_machine

  local ref="$FLAKE_REF"
  [ "$USE_SELF" -eq 1 ] && ref="$SELF_FLAKE_REF"

  local backend="none"
  backend=$(detect_backend "$ref")
  local do_proton=0
  if [ "$backend" = "proton-pass" ]; then
    proton_flow || die "Aborted at the Proton Pass step."
    do_proton=1
  fi

  gum style --border double --padding "1 2" --margin "1 0" \
    "Install host : $HOST" \
    "Machine      : ${MACHINE:-<host default>}$([ "$USE_SELF" -eq 1 ] && echo "  (freshly generated)")" \
    "Secrets      : $backend"
  gum confirm "Proceed? This ERASES the target disk." || die "Aborted before install."

  local rc=0
  if [ "$USE_SELF" -eq 1 ]; then
    INSTALL_FLAKE_REF="$SELF_FLAKE_REF" INSTALL_CLONE_URL="$SELF_FLAKE_REF" \
      install-cala-m-os "$HOST" "self" || rc=$?
  elif [ -n "$MACHINE" ]; then
    install-cala-m-os "$HOST" "$MACHINE" || rc=$?
  else
    install-cala-m-os "$HOST" || rc=$?
  fi

  [ "$rc" -eq 0 ] || die "install-cala-m-os failed (exit $rc)."

  [ "$do_proton" -eq 1 ] && seed_proton_target

  gum style --border rounded --padding "1 2" --margin "1 0" --foreground 2 \
    "Cala-M-OS host '$HOST' installed." \
    "Reboot to boot into your new system."
}

main "$@"
