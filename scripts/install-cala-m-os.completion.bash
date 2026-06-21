# bash completion for install-cala-m-os (shipped on the Cala-M-OS installer ISO).
# Arg 1 completes a host configuration name; arg 2 an optional machine name.
_install_cala_m_os() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${COMP_CWORD}" -eq 1 ]]; then
    local hosts="ai lanstation devbox ephemeral homelab simple battlestation broadcast openreturn livedata"
    mapfile -t COMPREPLY < <(compgen -W "$hosts" -- "$cur")
  elif [[ "${COMP_CWORD}" -eq 2 ]]; then
    local machines="A520M-ITX B760-PLUS B850-MAX FW13-11XXP FW13-12XXP FW16-AMD-AI MS-01 MS-02 TRX50-SAGE ZIMA X-Small Small Medium Large"
    mapfile -t COMPREPLY < <(compgen -W "$machines" -- "$cur")
  fi
}
complete -F _install_cala_m_os install-cala-m-os
