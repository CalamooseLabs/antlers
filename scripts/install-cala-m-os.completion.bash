# bash completion for install-cala-m-os (shipped on the Cala-M-OS installer ISO).
# Arg 1 completes a host configuration name; arg 2 an optional machine name.
# The static lists are a snapshot of the flake; the installer image exports the
# live ones (CALA_INSTALLER_HOSTS / _MACHINES / _VM_MACHINES, computed from the
# flake by cala-m-os iso/installer.nix), which win when set.
_install_cala_m_os() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${COMP_CWORD}" -eq 1 ]]; then
    local hosts="${CALA_INSTALLER_HOSTS:-ai battlestation broadcast devbox ephemeral homelab lanstation livedata openreturn simple tci-cloud tci-private webhost}"
    mapfile -t COMPREPLY < <(compgen -W "$hosts" -- "$cur")
  elif [[ "${COMP_CWORD}" -eq 2 ]]; then
    local machines="${CALA_INSTALLER_MACHINES:-A520M-ITX B760-PLUS B850-MAX FW13-11XXP FW13-12XXP FW16-AMD-AI HETZNER-CAX HETZNER-CLOUD MS-01 MS-02 TCI-LOCAL TRX50-SAGE ZIMA} ${CALA_INSTALLER_VM_MACHINES:-X-Small Small Medium Large}"
    mapfile -t COMPREPLY < <(compgen -W "$machines" -- "$cur")
  fi
}
complete -F _install_cala_m_os install-cala-m-os
