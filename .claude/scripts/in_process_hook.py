"""A hook's verdict, asked in this process the way its `__main__` block asks.

**The harness suite paid a process for every guard judgement**
(blueprint-frontend#74), and on Windows process creation is the scarce
resource: blueprint-frontend#62 counted 1 296 guard and launcher spawns,
399.8 s of a 1 223.5 s serial run, on the job that is the critical path of
the whole CI workflow. The same judgement made here costs well under a
millisecond and was measured identical — `(returncode,
permissionDecisionReason)` over 40 commands lifted from the suite's own
literals, zero differences.

**It is one helper rather than a copy per test file**, because the three
properties below are what make the speed-up safe, and a copy is where one of
them is dropped. `test_index_refresh.py`'s `load()` and
`test_egress_proxy.py`'s `load_proxy()` are the precedent for importing a hook;
this adds the entry point, the streams and the reset.

1. **Through the entry point the `__main__` block calls, never the judgement
   function.** `main()` carries the `except Exception → refuse` handler and
   the JSON-on-stdout contract — `guard-triager-edit.py`'s `run()` carries its
   crash handler — so a case calling `offence()` directly would test neither.
   `run` therefore hands back what a spawn hands back: an exit status, stdout
   and stderr, in a `subprocess.CompletedProcess`, and every assertion written
   against a spawn reads it unchanged.
2. **Module globals are put back between cases.** `guard-git-argv.py` keeps
   the event's directory in `EVENT_CWD`, and its `main()` sets it only once an
   event is a Bash call it will judge — so a module kept across cases lets one
   case's `cwd` decide the next one's verdict. The namespace is snapshotted
   once, straight after import, and restored before **and** after every call,
   which resets `EVENT_CWD` and any global a later edit adds, without a list
   here to fall behind the hooks.
3. **It is not the wiring, and the suite keeps spawning where the wiring is
   the subject.** The launcher, the interpreter, stdin and the exit status are
   reached only by a real process, so each class that judges through here
   keeps a handful of spawned controls; and a case whose assertion is a
   subprocess `timeout` — the scan-budget cases in `TheGitArgvGuard` —
   stays a spawn, because in-process nothing can cut it off and the
   mechanism that fails it would be gone.

**What a spawn has and this does not** is a fresh interpreter, and of what
that buys only the stack reaches a verdict. A judgement that recurses has a
crash handler that refuses, so a hook entered with this suite's frames already
beneath it would refuse a command a real spawn admits — and an
`assertRefused` would pass on the crash. So the recursion limit is raised for
the call by exactly the frames this process stands on, and the hook starts
with the headroom `python <hook>` gives it: no more, which would admit what a
spawn refuses, and no less. The rest of a fresh interpreter — a clean
`sys.modules`, and a `__pycache__`-less compile of the hook on every call — is
the cost this module exists to stop paying.
"""

import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import traceback
from pathlib import Path
from unittest import mock

_LOADED = {}


def load(path):
    """The hook at `path`, imported once, and its namespace as imported."""
    path = Path(path).resolve()
    if path not in _LOADED:
        name = "in_process_" + path.stem.replace("-", "_")
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED[path] = (module, dict(vars(module)))
    return _LOADED[path]


def _restore(module, pristine):
    namespace = vars(module)
    for name in [name for name in namespace if name not in pristine]:
        del namespace[name]
    namespace.update(pristine)


def run(path, input="", env=None, entry="main"):
    """What `subprocess.run([sys.executable, path], input=input, env=env,
    capture_output=True, text=True)` returns, without the process.

    `entry` is the function the hook's `__main__` block hands to `sys.exit`;
    `env`, when given, replaces the environment for the call as it would for
    a child. An exception escaping the entry point is a traceback on stderr
    and exit status 1, which is what the interpreter does with it.
    """
    module, pristine = load(path)
    stdin = io.TextIOWrapper(io.BytesIO(input.encode("utf-8")),
                             encoding="utf-8")
    stdout, stderr = io.StringIO(), io.StringIO()
    environment = (mock.patch.dict(os.environ, env, clear=True)
                   if env is not None else contextlib.nullcontext())
    # `python <hook>` enters the entry point two frames deep — the module and
    # the entry — so the hook gets the frames beneath this one back, less the
    # one this function stands in for.
    depth, frame = 0, sys._getframe()
    while frame is not None:
        depth, frame = depth + 1, frame.f_back
    limit = sys.getrecursionlimit()
    _restore(module, pristine)
    try:
        sys.setrecursionlimit(limit + depth - 1)
        with environment, mock.patch.object(sys, "stdin", stdin), \
                contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            try:
                code = getattr(module, entry)()
            except SystemExit as stop:
                code = stop.code
            except Exception:  # noqa: BLE001 - the interpreter's own answer
                traceback.print_exc()
                code = 1
            if code is None:
                code = 0
            elif not isinstance(code, int):
                print(code, file=sys.stderr)
                code = 1
    finally:
        sys.setrecursionlimit(limit)
        _restore(module, pristine)
    return subprocess.CompletedProcess(
        [sys.executable, str(path)], code, stdout.getvalue(), stderr.getvalue())
