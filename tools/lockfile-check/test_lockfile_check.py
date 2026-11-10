"""The lockfile check's suite, over lockfiles written to a temporary directory.

    cd tools/lockfile-check && python -m unittest
"""

import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import lockfile_check
from lockfile_check import DEFAULT, REGISTRY, Unreadable, check, main

GOOD = {
    "name": "blueprint-frontend",
    "version": "0.0.0",
    "lockfileVersion": 3,
    "requires": True,
    "packages": {
        "": {"name": "blueprint-frontend", "version": "0.0.0"},
        "node_modules/left-pad": {
            "version": "1.3.0",
            "resolved": f"{REGISTRY}left-pad/-/left-pad-1.3.0.tgz",
            "integrity": "sha512-BBBB",
        },
        "node_modules/@scope/pkg": {
            "version": "2.0.0",
            "resolved": f"{REGISTRY}@scope/pkg/-/pkg-2.0.0.tgz",
            "integrity": "sha512-AAAA",
        },
        "node_modules/@scope/pkg/node_modules/bundled": {"version": "1.0.0", "inBundle": True},
    },
}


class Lockfile:
    """A package-lock.json written from a dict or raw text into a temporary directory."""

    def __init__(self, test):
        temporary = tempfile.TemporaryDirectory()
        test.addCleanup(temporary.cleanup)
        self.dir = Path(temporary.name)

    def write(self, document=None, text=None):
        path = self.dir / "package-lock.json"
        path.write_text(text if text is not None else json.dumps(document), encoding="utf-8")
        return path


def with_entry(path, **fields):
    """GOOD with one entry's fields set, a field given None removed."""
    document = copy.deepcopy(GOOD)
    entry = document["packages"].setdefault(path, {"version": "1.0.0"})
    for key, value in fields.items():
        if value is None:
            entry.pop(key, None)
        else:
            entry[key] = value
    return document


class Refusals(unittest.TestCase):
    def setUp(self):
        self.lockfile = Lockfile(self)

    def refused(self, document):
        _, found = check(self.lockfile.write(document))
        return found

    def test_a_clean_lockfile_has_none_and_counts_every_entry_but_the_root(self):
        checked, found = check(self.lockfile.write(GOOD))
        self.assertEqual(found, [])
        self.assertEqual(checked, 3)

    def test_a_resolved_on_another_host_is_refused(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", resolved="https://evil.example/left-pad-1.3.0.tgz"))
        self.assertEqual(len(found), 1)
        self.assertIn("node_modules/left-pad", found[0])
        self.assertIn("is not on", found[0])

    def test_a_host_that_only_starts_with_the_registry_name_is_refused(self):
        for resolved in (
            "https://registry.npmjs.org.evil.example/left-pad-1.3.0.tgz",
            "https://registry.npmjs.org@evil.example/left-pad-1.3.0.tgz",
            "https://registry.npmjs.org:8443/left-pad-1.3.0.tgz",
        ):
            with self.subTest(resolved=resolved):
                found = self.refused(with_entry("node_modules/left-pad", resolved=resolved))
                self.assertEqual(len(found), 1, found)

    def test_plain_http_to_the_registry_is_refused(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", resolved="http://registry.npmjs.org/left-pad-1.3.0.tgz"))
        self.assertEqual(len(found), 1)

    def test_a_git_a_file_and_a_link_resolved_are_refused(self):
        for resolved in (
            "git+ssh://git@github.com/someone/left-pad.git#abc123",
            "file:../left-pad",
            "projects/left-pad",
        ):
            with self.subTest(resolved=resolved):
                found = self.refused(with_entry("node_modules/left-pad", resolved=resolved))
                self.assertEqual(len(found), 1, found)

    def test_another_packages_registry_tarball_is_refused(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", resolved=f"{REGISTRY}evil-pkg/-/evil-pkg-1.0.0.tgz"))
        self.assertEqual(len(found), 1)
        self.assertIn("not this package's own tarball", found[0])

    def test_a_tarball_of_another_version_than_the_entry_names_is_refused(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", resolved=f"{REGISTRY}left-pad/-/left-pad-1.2.0.tgz"))
        self.assertEqual(len(found), 1)

    def test_a_scope_swapped_for_another_is_refused(self):
        found = self.refused(with_entry(
            "node_modules/@scope/pkg", resolved=f"{REGISTRY}@other/pkg/-/pkg-2.0.0.tgz"))
        self.assertEqual(len(found), 1)

    def test_an_entry_with_no_version_is_refused(self):
        found = self.refused(with_entry("node_modules/left-pad", version=None))
        self.assertEqual(len(found), 1)

    def test_a_nested_scoped_package_resolves_to_its_own_tarball(self):
        document = with_entry(
            "node_modules/left-pad/node_modules/@scope/inner", version="0.1.0-rc.1",
            resolved=f"{REGISTRY}@scope/inner/-/inner-0.1.0-rc.1.tgz", integrity="sha512-CCCC")
        self.assertEqual(self.refused(document), [])

    def test_an_alias_is_refused_even_with_the_aliased_packages_tarball(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", name="evil-pkg", version="1.0.0",
            resolved=f"{REGISTRY}evil-pkg/-/evil-pkg-1.0.0.tgz"))
        self.assertEqual(len(found), 1)
        self.assertIn("alias", found[0])

    def test_a_resolved_that_is_not_a_string_is_refused(self):
        found = self.refused(with_entry("node_modules/left-pad", resolved=["https://x"]))
        self.assertEqual(len(found), 1)

    def test_a_resolved_with_no_integrity_is_refused(self):
        found = self.refused(with_entry("node_modules/left-pad", integrity=None))
        self.assertEqual(len(found), 1)
        self.assertIn("no `integrity`", found[0])

    def test_an_empty_or_blank_integrity_is_refused(self):
        for integrity in ("", "   ", 0):
            with self.subTest(integrity=integrity):
                found = self.refused(with_entry("node_modules/left-pad", integrity=integrity))
                self.assertEqual(len(found), 1, found)

    def test_both_faults_in_one_entry_are_both_named(self):
        found = self.refused(with_entry(
            "node_modules/left-pad", resolved="https://evil.example/x.tgz", integrity=None))
        self.assertEqual(len(found), 2)

    def test_an_entry_with_no_resolved_is_refused_unless_bundled(self):
        found = self.refused(with_entry("node_modules/left-pad", resolved=None, integrity=None))
        self.assertEqual(len(found), 1)
        self.assertIn("no `resolved`", found[0])

    def test_a_bundled_entry_needs_neither(self):
        self.assertEqual(self.refused(with_entry("node_modules/x", inBundle=True)), [])

    def test_inbundle_must_be_true_not_merely_present(self):
        found = self.refused(with_entry("node_modules/x", inBundle="yes"))
        self.assertEqual(len(found), 1)

    def test_the_root_entry_is_never_checked(self):
        document = copy.deepcopy(GOOD)
        document["packages"][""]["resolved"] = "https://evil.example/root.tgz"
        self.assertEqual(self.refused(document), [])

    def test_an_entry_that_is_not_an_object_is_refused(self):
        document = copy.deepcopy(GOOD)
        document["packages"]["node_modules/odd"] = "1.0.0"
        self.assertEqual(len(self.refused(document)), 1)

    def test_every_offending_entry_is_named_not_only_the_first(self):
        document = with_entry("node_modules/left-pad", integrity=None)
        document["packages"]["node_modules/@scope/pkg"]["resolved"] = "https://evil.example/p.tgz"
        found = self.refused(document)
        self.assertEqual(len(found), 2)
        self.assertTrue(any("left-pad" in line for line in found))
        self.assertTrue(any("@scope/pkg" in line for line in found))


class Unreadables(unittest.TestCase):
    """A lockfile this check cannot read is never reported clean."""

    def setUp(self):
        self.lockfile = Lockfile(self)

    def test_another_lockfile_version_is_unreadable(self):
        for version in (1, 2, 4, "3", None):
            with self.subTest(version=version):
                document = copy.deepcopy(GOOD)
                document["lockfileVersion"] = version
                with self.assertRaises(Unreadable):
                    check(self.lockfile.write(document))

    def test_a_legacy_dependencies_map_is_unreadable(self):
        document = copy.deepcopy(GOOD)
        document["dependencies"] = {"left-pad": {"resolved": "https://evil.example/x.tgz"}}
        with self.assertRaises(Unreadable):
            check(self.lockfile.write(document))

    def test_a_missing_empty_or_wrong_packages_map_is_unreadable(self):
        for packages in (None, {}, [], "x"):
            with self.subTest(packages=packages):
                document = copy.deepcopy(GOOD)
                if packages is None:
                    del document["packages"]
                else:
                    document["packages"] = packages
                with self.assertRaises(Unreadable):
                    check(self.lockfile.write(document))

    def test_text_that_is_not_json_or_not_an_object_is_unreadable(self):
        for text in ("", "{", "[]", "3"):
            with self.subTest(text=text):
                with self.assertRaises(Unreadable):
                    check(self.lockfile.write(text=text))

    def test_a_missing_file_is_unreadable(self):
        with self.assertRaises(Unreadable):
            check(self.lockfile.dir / "absent.json")


class ExitCodes(unittest.TestCase):
    """What CI reads: 0 clean, 1 refused, 2 unreadable or misused."""

    def setUp(self):
        self.lockfile = Lockfile(self)

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_clean_exits_0(self):
        code, out, _ = self.run_main([str(self.lockfile.write(GOOD))])
        self.assertEqual(code, 0)
        self.assertIn("3 package(s)", out)

    def test_a_refusal_exits_1_with_an_error_annotation_per_entry(self):
        document = with_entry("node_modules/left-pad", integrity=None)
        code, out, _ = self.run_main([str(self.lockfile.write(document))])
        self.assertEqual(code, 1)
        self.assertEqual(out.count("::error::"), 1)

    def test_unreadable_exits_2(self):
        code, _, err = self.run_main([str(self.lockfile.write(text="{"))])
        self.assertEqual(code, 2)
        self.assertIn("::error::", err)

    def test_two_arguments_exit_2(self):
        code, _, _ = self.run_main(["a", "b"])
        self.assertEqual(code, 2)

    def test_the_script_runs_as_ci_runs_it(self):
        path = self.lockfile.write(with_entry("node_modules/left-pad", integrity=None))
        script = Path(lockfile_check.__file__)
        result = subprocess.run(
            [sys.executable, str(script), str(path)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1, result.stderr)


class TheRealLockfile(unittest.TestCase):
    """The subject is what the gate looks at: this checkout's own lockfile."""

    def test_the_default_is_the_repository_root_lockfile(self):
        self.assertEqual(DEFAULT.name, "package-lock.json")
        self.assertTrue((DEFAULT.parent / "package.json").is_file(), DEFAULT)

    def test_it_passes_and_reads_every_entry(self):
        checked, found = check(DEFAULT)
        self.assertEqual(found, [])
        packages = json.loads(DEFAULT.read_text(encoding="utf-8"))["packages"]
        self.assertEqual(checked, len(packages) - 1)
        self.assertGreater(checked, 100, "a lockfile this small is not the one CI installs")


if __name__ == "__main__":
    unittest.main()
