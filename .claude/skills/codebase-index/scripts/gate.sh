# Sourced by run-index and cbx, never run: `gate_index <scripts-dir>`.
#
# Judges the index before the CLI opens it, by running gate-index.py with the
# first interpreter that meets the floor the hooks keep (Python 3.12). `python3`
# on Windows can be the Microsoft Store alias, which fails the probe and is
# skipped, as run-guard.sh skips it. No interpreter is a refusal, not a pass:
# the CLI would otherwise open an index nobody judged, and the harness needs
# this Python anyway (alexander-shamray/blueprint-frontend#138).
gate_index() {
  gate_probe='import sys; sys.exit(sys.version_info < (3, 12))'
  for gate_python in 'py -3.12' python3 python; do
    # Unquoted on purpose: 'py -3.12' is a command and its argument.
    if $gate_python -c "$gate_probe" >/dev/null 2>&1; then
      $gate_python -I "$1/gate-index.py"
      return $?
    fi
  done
  echo "gate-index: no Python 3.12 or newer, so the index cannot be judged; refusing to open it" >&2
  return 4
}
