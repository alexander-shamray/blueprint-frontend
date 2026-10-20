"""sweep-slices.sh and sweep-mark.sh: the partition, the budget and the ref.

blueprint-frontend#172, ported from blueprint-backend's suite of the same name. The differences
are this tree's rows, a local `run_bash` as every suite in this directory carries for itself, and
one case the port added: the helper is written for bash 3.2, which is what macOS ships.

The partition runs against this repository's own tree, so a new top-level directory no row owns
fails here before a sweep passes over it.

Run: py -3.12 -m unittest discover -s .claude/scripts
Needs bash and git on PATH.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
BASH = shutil.which("bash")
GIT = shutil.which("git")
SLICES = SCRIPTS / "sweep-slices.sh"
MARK = SCRIPTS / "sweep-mark.sh"
DETACH = SCRIPTS / "git-worktree-detach.sh"
DROP = SCRIPTS / "git-worktree-drop.sh"
REPO = str(SCRIPTS.parent.parent)
BUDGET = 240000
GIT_ID = "-c user.name=t -c user.email=t@example.invalid"

# A path that does not exist reads as an empty config file on every platform,
# so the developer's own gitconfig is not live inside a fixture.
NO_CONFIG = str(SCRIPTS / "no-such-gitconfig-for-the-fixtures")

ROWS = {
    "bug": {"core", "screens", "suites", "tooling", "native", "samples"},
    "security": {"source", "tooling", "native", "samples"},
}


def setUpModule():
    # Not a skip: a skip on a missing tool reports a pass, which is the
    # fail-open every gate in this repository is written against.
    missing = [name for name, path in (("bash", BASH), ("git", GIT)) if path is None]
    if missing:
        raise RuntimeError(f"{', '.join(missing)} required and not on PATH")


def run_bash(script, **env_extra):
    """Run a bash fragment. Everything variable travels in the environment:
    under MSYS an argv element crossing into `bash.exe` is re-parsed, so a path
    arrives mangled and the case silently tests something else.
    """
    env = dict(os.environ)
    env.setdefault("GIT_CONFIG_GLOBAL", NO_CONFIG)
    env.setdefault("GIT_CONFIG_SYSTEM", NO_CONFIG)
    env.update(env_extra)
    return subprocess.run([BASH, "-c", script], capture_output=True, text=True, env=env)


def code_lines(text):
    """The executable lines of a script. A scan of the whole file would read
    the comment that explains a refusal as the defect it refuses."""
    return [line.strip() for line in text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")]


def git(repo, args):
    result = run_bash(f'cd "$R" && git {GIT_ID} {args}', R=repo)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


class Sweep:
    """A detached sweep worktree of `repo`, dropped with its slices afterwards."""

    def __init__(self, case, repo):
        self.repo = repo
        sha = git(repo, "rev-parse HEAD")
        made = run_bash(
            'cd "$R" && bash "$DETACH" "$SHA" 2>/dev/null', R=repo, DETACH=str(DETACH), SHA=sha
        )
        case.assertEqual(0, made.returncode, made.stderr)
        self.path = made.stdout.strip()
        case.addCleanup(
            lambda: run_bash(
                'cd "$R" && bash "$DROP" "$W" >/dev/null 2>&1; rm -rf "$W.slices"',
                R=repo, DROP=str(DROP), W=self.path,
            )
        )

    def slices(self, kind, *extra):
        return run_bash(
            'cd "$R" && bash "$SLICES" "$KIND" "$W" $EXTRA',
            R=self.repo, SLICES=str(SLICES), KIND=kind, W=self.path, EXTRA=" ".join(extra),
        )


def parse(stdout):
    head, slices = {}, []
    for line in stdout.splitlines():
        word, _, rest = line.partition(" ")
        if word == "slice":
            n, row, files, size, listing = rest.split(" ")
            slices.append((row, int(files), int(size), listing))
        elif word == "tracked":
            words = line.split(" ")
            head["counts"] = {k: int(v) for k, v in zip(words[::2], words[1::2])}
        else:
            head[word] = rest
    return head, slices


def listed(slices):
    """The listed paths, read by bash: the helper prints its own spelling, which
    under MSYS is a POSIX path Python resolves to another directory."""
    paths = []
    for *_, listing in slices:
        read = run_bash('cat -- "$P"', P=listing)
        assert read.returncode == 0, read.stderr
        paths += read.stdout.splitlines()
    return paths


class TheRealTree(unittest.TestCase):
    """Both partitions hold over this repository, within the budget."""

    def test_every_tracked_path_is_listed_or_counted_and_every_slice_fits(self):
        # `full`, so a ref a real sweep left in this checkout does not narrow it.
        sweep = Sweep(self, REPO)
        tracked = len(git(REPO, "ls-tree -r --name-only --full-tree HEAD").splitlines())
        for kind in ("bug", "security"):
            with self.subTest(kind=kind):
                run_bash('rm -rf "$W.slices"', W=sweep.path)
                result = sweep.slices(kind, "full")
                self.assertEqual(0, result.returncode, result.stderr)
                head, slices = parse(result.stdout)
                self.assertEqual("full", head["mode"])
                counts = head["counts"]
                self.assertEqual(tracked, counts["tracked"])
                skipped = sum(v for k, v in counts.items() if k not in ("tracked", "listed"))
                self.assertEqual(counts["tracked"], counts["listed"] + skipped)
                for row, files, size, _ in slices:
                    self.assertTrue(size <= BUDGET or files == 1, (row, files, size))
                    self.assertIn(row, ROWS[kind])
                paths = listed(slices)
                self.assertEqual(counts["listed"], len(paths))
                self.assertEqual(len(paths), len(set(paths)), "a path in two slices")
                for top in ("src/", "e2e/", "tools/", ".claude/", "docs/", "android/", "ios/"):
                    self.assertTrue(any(p.startswith(top) for p in paths), top)
                self.assertTrue(any("/" not in p for p in paths), "the root files")
                self.assertFalse(any(p.startswith("docs/superpowers/") for p in paths))


# One file in every row both sweeps own, so a small repository partitions the
# way this one does; a clone of this one checks out every file per test.
SMALL_TREE = {
    "src/app/core/a.ts": "x\n", "src/app/features/b.ts": "x\n", "src/app/shared/c.ts": "x\n",
    "src/app/core/a.spec.ts": "x\n", "e2e/d.spec.ts": "x\n", "public/e.txt": "x\n",
    "tools/f.py": "x\n", ".github/g.yml": "x\n", ".claude/h.md": "x\n", ".vscode/i.json": "x\n",
    "android/j.kt": "x\n", "ios/k.swift": "x\n", "README.md": "x\n",
    "docs/l.md": "```sh\nx\n```\n", "docs/superpowers/m.md": "```sh\nx\n```\n",
}


class ASmallRepository(unittest.TestCase):
    """A small repository of its own, so a commit and a ref never touch this one."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="sweepslices-")
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        made = run_bash('cd "$R" && git init -q --initial-branch=main .', R=self.repo)
        self.assertEqual(0, made.returncode, made.stderr)
        for relative, text in SMALL_TREE.items():
            target = Path(self.repo, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        git(self.repo, "add -A")
        git(self.repo, 'commit -q -m "the small tree"')

    def commit(self, relative, text):
        target = Path(self.repo, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        git(self.repo, f'add -- "{relative}"')
        git(self.repo, f'commit -q -m "add {relative}"')
        return git(self.repo, "rev-parse HEAD")

    def mark(self, kind, sha):
        return run_bash(
            'cd "$R" && bash "$MARK" "$KIND" "$SHA"', R=self.repo, MARK=str(MARK), KIND=kind, SHA=sha
        )

    def test_each_row_a_sweep_owns_gets_its_files(self):
        sweep = Sweep(self, self.repo)
        expected = {
            "bug": {
                "core": ["src/app/core/a.ts"],
                "screens": ["public/e.txt", "src/app/features/b.ts", "src/app/shared/c.ts"],
                "suites": ["e2e/d.spec.ts", "src/app/core/a.spec.ts"],
                "tooling": [".claude/h.md", ".github/g.yml", ".vscode/i.json", "tools/f.py"],
                "native": ["README.md", "android/j.kt", "ios/k.swift"],
                "samples": ["docs/l.md"],
            },
            "security": {
                "source": ["e2e/d.spec.ts", "public/e.txt", "src/app/core/a.spec.ts",
                           "src/app/core/a.ts", "src/app/features/b.ts", "src/app/shared/c.ts"],
                "tooling": [".claude/h.md", ".github/g.yml", ".vscode/i.json", "tools/f.py"],
                "native": ["README.md", "android/j.kt", "ios/k.swift"],
                "samples": ["docs/l.md"],
            },
        }
        for kind, rows in expected.items():
            with self.subTest(kind=kind):
                run_bash('rm -rf "$W.slices"', W=sweep.path)
                result = sweep.slices(kind)
                self.assertEqual(0, result.returncode, result.stderr)
                _, slices = parse(result.stdout)
                self.assertEqual(set(rows), {row for row, *_ in slices})
                for row, files, size, listing in slices:
                    self.assertEqual(rows[row], sorted(listed([(row, files, size, listing)])))

    def test_a_top_level_directory_no_row_owns_refuses_the_run(self):
        self.commit("newtree/x.txt", "x\n")
        sweep = Sweep(self, self.repo)
        for kind in ("bug", "security"):
            with self.subTest(kind=kind):
                result = sweep.slices(kind)
                self.assertEqual(3, result.returncode)
                self.assertIn("no row owns: newtree/x.txt", result.stderr)
                self.assertNotIn("slice ", result.stdout)

    def test_a_refused_run_leaves_no_slices_behind(self):
        self.commit("newtree/x.txt", "x\n")
        sweep = Sweep(self, self.repo)
        self.assertEqual(3, sweep.slices("bug").returncode)
        gone = run_bash('[ ! -e "$W.slices" ] && echo gone', W=sweep.path)
        self.assertEqual("gone", gone.stdout.strip(), gone.stderr)

    def test_a_marked_ancestor_narrows_round_one_to_the_change(self):
        base = git(self.repo, "rev-parse HEAD")
        self.assertEqual(0, self.mark("bug", base).returncode)
        self.commit("tools/added.py", "print(1)\n")
        result = Sweep(self, self.repo).slices("bug")
        self.assertEqual(0, result.returncode, result.stderr)
        head, slices = parse(result.stdout)
        self.assertEqual(f"since {base}", head["mode"])
        self.assertEqual(["tools/added.py"], listed(slices))
        # Everything else the tree holds is counted as unchanged, not dropped unsaid.
        self.assertEqual(len(SMALL_TREE), head["counts"]["unchanged"])

    def test_a_sample_counts_its_fences_and_a_doc_without_one_is_counted_not_listed(self):
        self.assertEqual(0, self.mark("bug", git(self.repo, "rev-parse HEAD")).returncode)
        body = "```ts\nconst x = 1;\n```\n"
        nested = "````md\n```\ninner\n```\n````\nprose after\n"
        self.commit("docs/fenced.md", "# t\n" + body)
        self.commit("docs/nested.md", nested)
        self.commit("docs/plain.md", "no code here\n")
        result = Sweep(self, self.repo).slices("bug")
        self.assertEqual(0, result.returncode, result.stderr)
        head, slices = parse(result.stdout)
        self.assertEqual(["docs/fenced.md", "docs/nested.md"], sorted(listed(slices)))
        self.assertEqual(1, head["counts"]["fenceless"])
        # The fenced line alone; the nested fence's body is its three inner lines.
        self.assertEqual(len("const x = 1;\n") + len("```\ninner\n```\n"), sum(s[2] for s in slices))

    def test_the_closed_records_are_counted_and_not_read(self):
        result = Sweep(self, self.repo).slices("security")
        self.assertEqual(0, result.returncode, result.stderr)
        head, slices = parse(result.stdout)
        self.assertEqual(1, head["counts"]["record"])
        self.assertNotIn("docs/superpowers/m.md", listed(slices))

    def test_a_row_is_cut_at_the_budget_and_one_large_file_stands_alone(self):
        chunk = "x" * 130000 + "\n"
        for name in ("one", "two", "three"):
            self.commit(f"tools/{name}.py", chunk)
        self.commit("tools/huge.py", "y" * (BUDGET + 60000) + "\n")
        result = Sweep(self, self.repo).slices("bug")
        self.assertEqual(0, result.returncode, result.stderr)
        _, slices = parse(result.stdout)
        tooling = [s for s in slices if s[0] == "tooling"]
        self.assertGreater(len(tooling), 3)
        for _, files, size, _ in tooling:
            self.assertTrue(size <= BUDGET or files == 1, (files, size))
        huge = [s for s in tooling if s[2] > BUDGET]
        self.assertEqual(1, len(huge))
        self.assertEqual(1, huge[0][1])

    def test_full_and_a_non_ancestor_ref_both_read_everything(self):
        self.commit("tools/added.py", "print(1)\n")
        tip = git(self.repo, "rev-parse HEAD")
        sweep = Sweep(self, self.repo)
        self.assertEqual(0, self.mark("bug", tip).returncode)
        result = sweep.slices("bug", "full")
        self.assertEqual("full", parse(result.stdout)[0]["mode"])
        # A side commit is no ancestor of the swept one.
        git(self.repo, "checkout -q --detach HEAD~1")
        side = self.commit("tools/side.py", "print(2)\n")
        self.assertEqual(0, self.mark("bug", side).returncode)
        run_bash('rm -rf "$W.slices"', W=sweep.path)
        result = sweep.slices("bug")
        self.assertEqual("full", parse(result.stdout)[0]["mode"], result.stderr)

    def test_mark_takes_a_closed_kind_and_a_full_existing_commit(self):
        sha = git(self.repo, "rev-parse HEAD")
        for kind, commit, code in (
            ("other", sha, 2), ("bug", sha[:12], 2), ("bug", "0" * 40, 3), ("bug", "HEAD", 2)
        ):
            with self.subTest(kind=kind, commit=commit):
                self.assertEqual(code, self.mark(kind, commit).returncode)
        self.assertEqual(0, self.mark("security", sha).returncode)
        self.assertEqual(sha, git(self.repo, "rev-parse refs/sweeps/security"))

    def test_the_slices_go_with_the_worktree(self):
        sweep = Sweep(self, self.repo)
        self.assertEqual(0, sweep.slices("security").returncode)
        dropped = run_bash(
            'cd "$R" && bash "$DROP" "$W" && [ ! -e "$W.slices" ] && echo gone',
            R=self.repo, DROP=str(DROP), W=sweep.path,
        )
        self.assertEqual("gone", dropped.stdout.strip(), dropped.stderr)


class TheTablesNameTheHelpersRows(unittest.TestCase):
    """Each command's row table names exactly the rows the helper prints."""

    def test_each_table_matches_the_rows(self):
        for kind in ("bug", "security"):
            with self.subTest(kind=kind):
                text = (SCRIPTS.parent / "commands" / f"{kind}-sweep.md").read_text(encoding="utf-8")
                table = set(re.findall(r"^   \| `([a-z-]+)` \|", text, re.MULTILINE))
                self.assertEqual(ROWS[kind], table)

    def test_the_rows_this_suite_names_are_the_ones_the_helper_can_print(self):
        source = SLICES.read_text(encoding="utf-8")
        body = source[source.index("function row_of("):source.index("FILENAME == ARGV[1]")]
        printed = set(re.findall(r'return "([a-z]+)"', body)) - {""}
        self.assertEqual(ROWS["bug"] | ROWS["security"], printed)


class Arguments(unittest.TestCase):
    def test_a_path_not_shaped_like_a_sweep_worktree_is_refused(self):
        result = run_bash('bash "$SLICES" bug "$P"', SLICES=str(SLICES), P=REPO)
        self.assertEqual(2, result.returncode)

    def test_kind_and_mode_are_closed_sets(self):
        for args in ("other /tmp", "bug /tmp since", "bug"):
            with self.subTest(args=args):
                result = run_bash(f'bash "$SLICES" {args}', SLICES=str(SLICES))
                self.assertEqual(2, result.returncode)


class ForBashThreeTwo(unittest.TestCase):
    """macOS ships bash 3.2 as /bin/bash, and CI's macOS job runs this suite
    (docs/testing.md); the backend's helper used constructs that shell lacks."""

    BASH4 = re.compile(
        r"\bmapfile\b|\breadarray\b|\bdeclare\s+-A\b|\blocal\s+-A\b|\$\{[A-Za-z_]+(,,|\^\^)\}"
        r"|\bcoproc\b|&>>|\|&")

    def test_no_helper_here_uses_a_bash_4_construct(self):
        for path in (SLICES, MARK):
            with self.subTest(helper=path.name):
                for line in code_lines(path.read_text(encoding="utf-8")):
                    self.assertIsNone(self.BASH4.search(line), line)


if __name__ == "__main__":
    unittest.main()
