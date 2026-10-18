# Windows PowerShell wrapper around the installed `codebase-index` CLI.
# Mirrors scripts/cbx: whitelist, then PATH CLI, then py -3.12, then python -m.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Subcommand,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$probe = "import sys; sys.version_info >= (3, 12) or sys.exit(1); import codebase_index"
$allowed = @(
    "search", "explain", "architecture", "symbol", "refs", "impact", "diff-impact",
    "path", "describe", "verify", "graph", "stats", "doctor", "update", "index"
)

if ($allowed -notcontains $Subcommand) {
    [Console]::Error.WriteLine("cbx: refusing subcommand '$Subcommand'. Allowed: $($allowed -join ', ')")
    exit 2
}

# As scripts/cbx: the skill's auto-update disabled, the working directory off
# `sys.path`, and the hooks' 3.12 floor checked before the probe imports
# anything (alexander-shamray/blueprint-frontend#151). A script runs in its
# caller's process, so both variables are put back in the `finally`, and the
# one exit after it is the only way out, rather than left set for every later
# `python` or `codebase-index` the caller starts (rounds 1 and 2 of #254's
# review).
$savedSafePath = $env:PYTHONSAFEPATH
$savedAutoUpdate = $env:CBX_NO_SKILL_AUTO_UPDATE
$saved = $ErrorActionPreference
$code = $null
try {
    $env:CBX_NO_SKILL_AUTO_UPDATE = "1"
    $env:PYTHONSAFEPATH = "1"
    $bin = Get-Command codebase-index -ErrorAction SilentlyContinue
    if ($bin) {
        & $bin.Source $Subcommand @Rest
        $code = $LASTEXITCODE
    }
    $ErrorActionPreference = "Continue"
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($null -eq $code -and $pyLauncher) {
        & $pyLauncher.Source -3.12 -c $probe 2>$null
        if ($LASTEXITCODE -eq 0) {
            $ErrorActionPreference = $saved
            & $pyLauncher.Source -3.12 -m codebase_index $Subcommand @Rest
            $code = $LASTEXITCODE
        }
    }
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $code -and $py) {
        & $py.Source -c $probe 2>$null
        if ($LASTEXITCODE -eq 0) {
            $ErrorActionPreference = $saved
            & $py.Source -m codebase_index $Subcommand @Rest
            $code = $LASTEXITCODE
        }
    }
} finally {
    $env:PYTHONSAFEPATH = $savedSafePath
    $env:CBX_NO_SKILL_AUTO_UPDATE = $savedAutoUpdate
    $ErrorActionPreference = $saved
}
if ($null -eq $code) {
    [Console]::Error.WriteLine("cbx: codebase-index CLI not on PATH and no Python 3.12 or newer can import codebase_index")
    $code = 127
}
exit $code
