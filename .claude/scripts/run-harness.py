"""Run the harness suite one test class per process, several at once.

`python -m unittest discover -s .claude/scripts -p 'test_*.py'` runs the
classes one after another, and on Windows most of their time is waiting for
`git` and Git Bash processes to start (alexander-shamray/blueprint-frontend
#259). The classes build their fixtures under the temporary directory and
share two things beside it: the directory itself, of which `run_class` gives
each class its own, and the host's time, which the classes in `ALONE` keep by
running after the rest. CI keeps the plain command because it is the gate: one
spelling on all three runners, and nothing between it and the suite.

**It counts what it ran against what discovery found**, and fails when the two
differ: a runner that silently dropped a class would report a green suite that
had not run, which is the failure every gate here is written against.

Usage, from the checkout root: py -3.12 .claude/scripts/run-harness.py [-j N]
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent.parent

# **Run alone, after the rest**: classes whose subject is a time limit, which
# a host busy with every other class can miss for no fault of the code — the
# detached worker's deadline in `TheDetachedWorkerReallyRuns`, and
# `index-refresh.py`'s `GIT_BUDGET` for one event's git calls. Under the full
# parallel load each was missed, a different case each run. A class missing
# from this set fails loudly rather than passing, so the set can only be
# short, never wrong.
ALONE = frozenset({
    "test_index_refresh.TheDetachedWorkerReallyRuns",
    "test_index_refresh.TheRootFollowsTheActiveWorktree",
})


def discovered():
    """Each test class discovery finds, with its test count, or a load failure."""
    suite = unittest.defaultTestLoader.discover(
        str(SCRIPTS), pattern="test_*.py", top_level_dir=str(SCRIPTS))
    counts, broken = {}, []

    def walk(node):
        for item in node:
            if isinstance(item, unittest.TestSuite):
                walk(item)
            elif type(item).__module__.startswith("unittest."):
                broken.append(str(item))
            else:
                name = f"{type(item).__module__}.{type(item).__name__}"
                counts[name] = counts.get(name, 0) + 1

    walk(suite)
    return counts, broken


def run_class(name):
    module, cls = name.split(".")
    started = time.monotonic()
    # **A temporary directory of its own**, because some cases read the
    # shared one: `TheFourPortedResiduals` asserts that a refused sweep left
    # no `secsweep-*` directory behind, and a sweep case running beside it
    # made one. Python reads TMP and TEMP, Git Bash's `mktemp` reads TMPDIR.
    # Its cleanup clears the read-only objects git writes, as the cases' own
    # do (#358), and ignores what is still held: a file a stray process keeps
    # open is the case's failure to report, not a reason to lose the run.
    holder = tempfile.TemporaryDirectory(prefix="harness-", ignore_cleanup_errors=True)
    scratch = Path(holder.name)
    env = dict(os.environ)
    for key in ("TMP", "TEMP", "TMPDIR"):
        env[key] = scratch.as_posix()
    try:
        done = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", ".claude/scripts",
             "-p", f"{module}.py", "-k", f"{module}.{cls}.*"],
            cwd=str(ROOT), capture_output=True, text=True, env=env)
    finally:
        holder.cleanup()
    ran = re.search(r"^Ran (\d+) tests?", done.stderr, re.MULTILINE)
    return name, done, int(ran.group(1)) if ran else 0, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # Twelve at most: measured at `bc2d627` on a 24-thread host, 312 s with
    # twelve and 319 s with twenty-four, because the longest class sets the
    # floor and more
    # workers only slow every class down.
    parser.add_argument("-j", "--jobs", type=int, default=min(os.cpu_count() or 4, 12))
    args = parser.parse_args()
    counts, broken = discovered()
    if broken:
        print("discovery could not load:", *broken, sep="\n  ")
        return 1
    started = time.monotonic()
    # The largest classes first, so the longest one is not the last to start.
    order = sorted((name for name in counts if name not in ALONE),
                   key=counts.get, reverse=True)
    stale = ALONE - set(counts)
    if stale:
        print("ALONE names a class discovery does not find:", *sorted(stale))
        return 1
    failed, total, timings = [], 0, []

    def record(name, done, ran, took):
        nonlocal total
        total += ran
        timings.append((took, name))
        if done.returncode or ran != counts[name]:
            failed.append((name, done, ran))

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for result in pool.map(run_class, order):
            record(*result)
    for name in sorted(ALONE):
        record(*run_class(name))
    for name, done, ran in failed:
        print(f"\n=== {name}: exit {done.returncode}, ran {ran} of {counts[name]}")
        print(done.stderr[-4000:])
    expected = sum(counts.values())
    print(f"\nslowest: " + ", ".join(f"{name} {took:.0f}s"
                                   for took, name in sorted(timings, reverse=True)[:5]))
    print(f"ran {total} of {expected} tests in {len(counts)} classes, "
          f"{args.jobs} at a time, in {time.monotonic() - started:.0f}s")
    if failed or total != expected:
        print("FAILED")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
