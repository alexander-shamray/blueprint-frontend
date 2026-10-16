"""git-worktree-fork.sh: the one worktree shape /branch step 5 creates.

The helper is `/branch`'s only route to `git worktree add`, so its refusals
are the boundary and this suite is what watches them: the path must be
`.claude/worktrees/<name>`, git must ignore it, and the fork must run from the
main checkout's root, where that relative path means what `/branch` says.

Ported from `alexander-shamray/blueprint-backend`, where the move into
`.claude/worktrees/` was built and reviewed. The harness is spelled here
rather than imported, for the reason `test_git_rebase_onto_main.py` gives:
each suite in this directory carries its own.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH, and nothing else: every case drives a real
repository.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FORK = SCRIPTS / "git-worktree-fork.sh"

# The fixtures answer for the script, not for whoever runs them: without this
# the developer's global gitconfig is live inside every fixture repository. A
# path that does not exist reads as an empty config file on every platform.
NO_CONFIG = str(SCRIPTS / "no-such-gitconfig-for-the-fixtures")

BASH = shutil.which("bash")
GIT = shutil.which("git")


def setUpModule():
    # Not a skip. A skip on a missing tool reports a pass, which is the
    # fail-open every gate in this repository is written against.
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if path is None]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} required and not on PATH: these tests exercise "
            "the same tools the script does"
        )


def run_bash(script, **env_extra):
    """Run a bash fragment with every input in the environment.

    Nothing is passed as an argument: under MSYS an argv element crossing into
    `bash.exe` is re-parsed, so a path arrives mangled and the case silently
    tests something else. Environment variables are not re-parsed.
    """
    env = dict(os.environ)
    env.setdefault("GIT_CONFIG_GLOBAL", NO_CONFIG)
    env.setdefault("GIT_CONFIG_SYSTEM", NO_CONFIG)
    # git reads its default excludes file whatever GIT_CONFIG_GLOBAL says, so a
    # developer whose global ignore lists .claude/ would pass the unignored case.
    env.setdefault("GIT_CONFIG_COUNT", "1")
    env.setdefault("GIT_CONFIG_KEY_0", "core.excludesFile")
    env.setdefault("GIT_CONFIG_VALUE_0", "")
    env.update(env_extra)
    return subprocess.run([BASH, "-c", script], capture_output=True,
                          text=True, env=env)


# A repository with an origin/main to fork from, made by bash so the paths are
# the ones the script sees. `IGNORE` decides whether .gitignore names the
# worktree directory, which is the check the ignored/unignored cases turn on.
FIXTURE = """
set -e
root=$(mktemp -d)
git init -q -b main "$root/origin"
git -C "$root/origin" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
if [ "$HOOK" != no ]; then
  # A launcher that records what it was asked, where, and with which event;
  # with HOOK=yes the hook it would run is there too.
  mkdir -p "$root/origin/.claude/hooks"
  cat > "$root/origin/.claude/hooks/run-guard.sh" <<'STUB'
{ printf '%s\\n' "$1"; pwd; cat; } > hook-ran.part && mv hook-ran.part hook-ran
STUB
  if [ "$HOOK" = yes ]; then
    printf '# stand-in\\n' > "$root/origin/.claude/hooks/index-refresh.py"
  fi
  git -C "$root/origin" add .claude
  git -C "$root/origin" -c user.name=t -c user.email=t@t commit -q -m hook
fi
git clone -q "$root/origin" "$root/checkout"
# Committed after the clone, so only origin/main carries the dangling link. Its
# target is the native spelling, which a Windows link resolves where bash does.
if [ "$LINK" = yes ]; then
  native=$(cd "$root" && { pwd -W 2>/dev/null || pwd; })
  blob=$(printf %s "$native/outside.json" | git -C "$root/origin" hash-object -w --stdin)
  git -C "$root/origin" update-index --add --cacheinfo "120000,$blob,.claude/settings.local.json"
  git -C "$root/origin" -c user.name=t -c user.email=t@t commit -q -m link
  git -C "$root/checkout" fetch -q origin
fi
if [ "$IGNORE" = yes ]; then printf '.claude/worktrees/\\n' > "$root/checkout/.gitignore"; fi
mkdir -p "$root/checkout/src"
printf '%s\\n' "$root"
"""


class ForkShape(unittest.TestCase):
    """The helper forks `.claude/worktrees/<name>` from the main checkout only."""

    def fixture(self, ignore="yes", hook="no", link="no"):
        made = run_bash(FIXTURE, IGNORE=ignore, HOOK=hook, LINK=link)
        self.assertEqual(0, made.returncode, made.stderr)
        root = made.stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$TARGET"', TARGET=root))
        return root

    def fork(self, where, path, branch="feat/probe", **env):
        return run_bash('cd "$WHERE" && bash "$FORK" "$P" "$B"',
                        WHERE=where, FORK=str(FORK), P=path, B=branch, **env)

    def local_settings(self, root, text):
        made = run_bash('mkdir -p "$C/.claude" && printf %s "$T" > "$C/.claude/settings.local.json"',
                        C=f"{root}/checkout", T=text)
        self.assertEqual(0, made.returncode, made.stderr)

    def probe_settings(self, root):
        return run_bash('cat "$W/.claude/settings.local.json"',
                        W=f"{root}/checkout/.claude/worktrees/probe")

    def checkout_file(self, root, name, text):
        made = run_bash('printf %s "$T" > "$C/$N"', C=f"{root}/checkout", N=name, T=text)
        self.assertEqual(0, made.returncode, made.stderr)

    def test_the_documented_shape_forks_with_no_upstream(self):
        root = self.fixture()
        checkout = f"{root}/checkout"
        result = self.fork(checkout, ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        head = run_bash('git -C "$W" branch --show-current',
                        W=f"{checkout}/.claude/worktrees/probe")
        self.assertEqual("feat/probe", head.stdout.strip(), head.stderr)
        # `--no-track`: a start point that is a remote-tracking ref would
        # otherwise become the upstream, and /pr would never set the right one.
        upstream = run_bash(
            'git -C "$C" rev-parse --abbrev-ref "feat/probe@{upstream}"',
            C=checkout)
        self.assertNotEqual(0, upstream.returncode, upstream.stdout)
        # The worktree sits inside the checkout, and ignored is what keeps it
        # out of every `git status` the chain reads.
        status = run_bash('git -C "$C" status --porcelain --untracked-files=all',
                          C=checkout)
        self.assertEqual(0, status.returncode, status.stderr)
        self.assertNotIn(".claude", status.stdout)

    def test_the_fork_starts_the_new_worktrees_index_refresh(self):
        # blueprint-frontend#127: /branch enters the worktree mid-session,
        # where no `SessionStart` fires, so the fork starts the refresh that
        # hook would have. Through THIS checkout's launcher, from this
        # checkout's root, with an event naming the worktree: the hook's
        # owner, and so the wrapper it runs, stays the trusted checkout and
        # never becomes the tree the session moves into.
        root = self.fixture(hook="yes")
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        ran = run_bash(
            'for _ in $(seq 300); do '
            '[ -s "$C/hook-ran" ] && exec cat "$C/hook-ran"; sleep 0.1; '
            'done; exit 1',
            C=f"{root}/checkout")
        self.assertEqual(0, ran.returncode, "the fork never ran the refresh")
        hook, where, event = ran.stdout.splitlines()
        self.assertEqual("index-refresh.py", hook)
        self.assertTrue(where.endswith("/checkout"), where)
        self.assertEqual({"cwd": ".claude/worktrees/probe"}, json.loads(event))
        # Asked through bash: `root` is bash's spelling of the temp directory,
        # which native Windows Python reads as a path that never exists.
        absent = run_bash('[ ! -e "$P" ]',
                          P=f"{root}/checkout/.claude/worktrees/probe/hook-ran")
        self.assertEqual(0, absent.returncode, "the launcher ran inside the worktree")

    def test_a_checkout_without_the_hook_still_forks_and_starts_nothing(self):
        # A base that predates the hook has a launcher with nothing to run,
        # or no launcher at all, and the fork is no less a fork for either.
        for hook in ("launcher", "no"):
            with self.subTest(hook=hook):
                root = self.fixture(hook=hook)
                result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
                self.assertEqual(0, result.returncode, result.stderr)
                # Long enough for a backgrounded launcher to have written, and
                # asked through bash, which spells `root` the way it was made.
                absent = run_bash('sleep 2; [ ! -e "$P" ]', P=f"{root}/checkout/hook-ran")
                self.assertEqual(0, absent.returncode, "a launcher ran with no hook to run")

    def test_the_mcp_approval_crosses_and_no_permission_does(self):
        # A session started in the worktree reads that directory's local
        # settings (blueprint-frontend#165), so the main checkout's approval
        # is carried there alone.
        root = self.fixture()
        self.local_settings(root, json.dumps({
            "enableAllProjectMcpServers": True,
            "enabledMcpjsonServers": ["codebase-index"],
            "permissions": {"allow": ["Bash(ls:*)"]}}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        copied = self.probe_settings(root)
        self.assertEqual(0, copied.returncode, copied.stderr)
        self.assertEqual({"enabledMcpjsonServers": ["codebase-index"]},
                         json.loads(copied.stdout))

    def test_the_approval_is_not_written_through_a_link_the_branch_carries(self):
        root = self.fixture(link="yes")
        self.local_settings(root, json.dumps({"enabledMcpjsonServers": ["codebase-index"]}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        linked = run_bash('[ -L "$W/.claude/settings.local.json" ]',
                          W=f"{root}/checkout/.claude/worktrees/probe")
        if linked.returncode != 0:
            self.skipTest("git checked the link out as a file: no symbolic links here")
        self.assertNotEqual(0, run_bash('[ -e "$R/outside.json" ]', R=root).returncode,
                            "the approval was written through the link")

    def test_a_checkout_approving_nothing_gives_the_worktree_no_settings(self):
        root = self.fixture()
        self.local_settings(root, json.dumps({"permissions": {"allow": ["Bash(ls:*)"]}}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("could not copy", result.stderr)
        self.assertNotEqual(0, self.probe_settings(root).returncode)

    def test_a_checkout_with_no_local_settings_forks_and_says_nothing(self):
        root = self.fixture()
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("could not copy", result.stderr)
        self.assertNotEqual(0, self.probe_settings(root).returncode)

    def test_an_unreadable_approval_still_forks_and_says_so(self):
        root = self.fixture()
        self.local_settings(root, "{not json")
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("could not copy the MCP approval", result.stderr)
        self.assertIn("JSONDecodeError", result.stderr)
        self.assertNotEqual(0, self.probe_settings(root).returncode)

    def test_an_approval_list_that_is_not_names_warns(self):
        # Anything else would leave the worktree's servers pending with
        # nothing said.
        root = self.fixture()
        self.local_settings(root, json.dumps({"enabledMcpjsonServers": "codebase-index"}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("could not copy the MCP approval", result.stderr)
        self.assertNotEqual(0, self.probe_settings(root).returncode)

    def test_approving_every_server_crosses_as_the_servers_defined(self):
        # Names cross, not the approve-all, so a server defined later still asks.
        for local in ({"enableAllProjectMcpServers": True},
                      {"enableAllProjectMcpServers": True, "enabledMcpjsonServers": ["codebase-index"]}):
            with self.subTest(local=local):
                root = self.fixture()
                self.checkout_file(root, ".mcp.json", json.dumps(
                    {"mcpServers": {"codebase-index": {}, "other": {}}}))
                self.local_settings(root, json.dumps(local))
                result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
                self.assertEqual(0, result.returncode, result.stderr)
                copied = self.probe_settings(root)
                self.assertEqual(0, copied.returncode, copied.stderr)
                self.assertEqual({"enabledMcpjsonServers": ["codebase-index", "other"]},
                                 json.loads(copied.stdout))

    def test_a_json_module_at_the_checkout_root_is_not_imported(self):
        # The approval is read by a Python run from the checkout root, whose
        # untracked files must not shadow the standard library.
        root = self.fixture()
        self.checkout_file(root, "json.py", 'raise SystemExit("shadowed")')
        self.local_settings(root, json.dumps({"enabledMcpjsonServers": ["codebase-index"]}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        copied = self.probe_settings(root)
        self.assertEqual(0, copied.returncode, copied.stderr)
        self.assertEqual({"enabledMcpjsonServers": ["codebase-index"]},
                         json.loads(copied.stdout))

    def test_a_disabled_server_does_not_cross(self):
        # The worktree may approve no server the main checkout refuses.
        root = self.fixture()
        self.local_settings(root, json.dumps({
            "enabledMcpjsonServers": ["codebase-index", "other"],
            "disabledMcpjsonServers": ["other"]}))
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(0, result.returncode, result.stderr)
        copied = self.probe_settings(root)
        self.assertEqual(0, copied.returncode, copied.stderr)
        self.assertEqual({"enabledMcpjsonServers": ["codebase-index"]},
                         json.loads(copied.stdout))

    def test_any_other_path_is_refused(self):
        root = self.fixture()
        for path in ("../sibling", ".claude/worktrees/../x",
                     ".claude/worktrees/a/b", "/tmp/x", ".claude/worktrees/-f",
                     "./.claude/worktrees/x", ".claude/worktrees/"):
            with self.subTest(path=path):
                result = self.fork(f"{root}/checkout", path)
                self.assertEqual(2, result.returncode, result.stderr)
                self.assertIn("must be .claude/worktrees/<name>", result.stderr)
        branches = run_bash('git -C "$C" branch --list feat/probe',
                            C=f"{root}/checkout")
        self.assertEqual("", branches.stdout.strip())

    def test_an_unignored_path_is_refused(self):
        root = self.fixture(ignore="no")
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("is not ignored", result.stderr)
        # Probed through bash: `root` is bash's spelling of the temp directory,
        # which native Windows Python reads as a path that never exists.
        absent = run_bash('[ ! -e "$P" ]',
                          P=f"{root}/checkout/.claude/worktrees/probe")
        self.assertEqual(0, absent.returncode)
        branches = run_bash('git -C "$C" branch --list feat/probe',
                            C=f"{root}/checkout")
        self.assertEqual("", branches.stdout.strip())

    def test_a_subdirectory_is_refused(self):
        root = self.fixture()
        result = self.fork(f"{root}/checkout/src", ".claude/worktrees/probe")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("checkout root", result.stderr)

    def test_a_linked_worktree_is_refused(self):
        root = self.fixture()
        first = self.fork(f"{root}/checkout", ".claude/worktrees/first",
                          "feat/first")
        self.assertEqual(0, first.returncode, first.stderr)
        # From inside the first worktree the same relative path would nest a
        # second one in it, which /branch step 0 refuses.
        inner = f"{root}/checkout/.claude/worktrees/first"
        result = self.fork(inner, ".claude/worktrees/second", "feat/second")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("not a linked worktree", result.stderr)

    def test_an_existing_branch_is_refused_rather_than_reset(self):
        root = self.fixture()
        made = run_bash('git -C "$C" branch feat/probe', C=f"{root}/checkout")
        self.assertEqual(0, made.returncode, made.stderr)
        result = self.fork(f"{root}/checkout", ".claude/worktrees/probe")
        self.assertEqual(3, result.returncode, result.stderr)
        self.assertIn("branch already exists", result.stderr)

    def test_outside_a_repository_says_so(self):
        made = run_bash('mktemp -d')
        self.assertEqual(0, made.returncode, made.stderr)
        outside = made.stdout.strip()
        self.addCleanup(lambda: run_bash('rm -rf "$TARGET"', TARGET=outside))
        # The temp root may itself sit inside some checkout; the ceiling keeps
        # git's discovery from walking up into it.
        ceiling = run_bash('cd "$D/.." && pwd -W 2>/dev/null || pwd', D=outside)
        result = self.fork(outside, ".claude/worktrees/probe",
                           GIT_CEILING_DIRECTORIES=ceiling.stdout.strip())
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("not in a git repository", result.stderr)


if __name__ == "__main__":
    unittest.main()
