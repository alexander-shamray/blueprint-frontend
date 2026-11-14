"""Refuse a package-lock.json that can install anything the registry did not pin.

Exit 0 clean, 1 an entry refused, 2 a lockfile it cannot read. README.md beside
this file owns what each refusal means, which entries are exempt, and why.
"""

import json
import re
import sys
from pathlib import Path

REGISTRY = "https://registry.npmjs.org/"
SUPPORTED_VERSION = 3

def default_lockfile():
    """The repository root's lockfile, found only when no path was given, so a copy of
    this script anywhere, `/tmp` included, still runs with an explicit one."""
    return Path(__file__).resolve().parents[2] / "package-lock.json"


class Unreadable(Exception):
    """The lockfile is not one this check reads, so it checked nothing."""


def packages_of(document):
    """The `packages` map of a version-3 lockfile, or Unreadable."""
    if not isinstance(document, dict):
        raise Unreadable("the lockfile is not a JSON object")
    version = document.get("lockfileVersion")
    if version != SUPPORTED_VERSION:
        raise Unreadable(
            f"lockfileVersion is {version!r}, and this check reads only version "
            f"{SUPPORTED_VERSION}'s `packages` map"
        )
    if "dependencies" in document:
        raise Unreadable(
            "the lockfile also carries a legacy `dependencies` map, which this check does not read"
        )
    packages = document.get("packages")
    if not isinstance(packages, dict) or not packages:
        raise Unreadable("the lockfile has no `packages` map, so there is nothing to check")
    return packages


def tarball(path, version):
    """The registry URL npm publishes the package installed at `path` under, at `version`."""
    name = re.split(r"(?:^|/)node_modules/", path)[-1]
    return f"{REGISTRY}{name}/-/{name.split('/')[-1]}-{version}.tgz"


def refusals(packages):
    """Every entry the lockfile would install unpinned or from elsewhere, as `path: reason`."""
    found = []
    for path, entry in packages.items():
        if path == "":
            continue
        if not isinstance(entry, dict):
            found.append(f"{path}: the entry is not an object")
            continue
        resolved = entry.get("resolved")
        if resolved is None:
            # A bundled package ships inside its parent's tarball, which the
            # parent's own `integrity` pins; anything else would be fetched by
            # name and version with no hash to hold it to.
            if entry.get("inBundle") is not True:
                found.append(f"{path}: no `resolved`, so npm fetches it unpinned")
            continue
        if not isinstance(resolved, str) or not resolved.startswith(REGISTRY):
            found.append(f"{path}: `resolved` {resolved!r} is not on {REGISTRY}")
        elif "name" in entry:
            # An alias installs another package under this path, so its tarball
            # is legitimately not this path's; none is admitted until one is
            # wanted and the check is taught which alias is meant.
            found.append(f"{path}: an alias (`name` {entry['name']!r}), which this check refuses")
        elif resolved != tarball(path, entry.get("version")):
            # On the registry is not enough: any published package's tarball
            # is, and `npm audit` would still judge it by this path's name.
            found.append(f"{path}: `resolved` {resolved!r} is not this package's own tarball")
        integrity = entry.get("integrity")
        if not isinstance(integrity, str) or not integrity.strip():
            found.append(f"{path}: `resolved` with no `integrity`")
    return found


def check(lockfile):
    """The checked entry count and the refusals, or Unreadable."""
    try:
        document = json.loads(Path(lockfile).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Unreadable(f"cannot read {lockfile}: {error}") from error
    packages = packages_of(document)
    return len(packages) - (1 if "" in packages else 0), refusals(packages)


def main(argv):
    if len(argv) > 1:
        print("usage: lockfile_check.py [package-lock.json]", file=sys.stderr)
        return 2
    lockfile = Path(argv[0]) if argv else default_lockfile()
    try:
        checked, found = check(lockfile)
    except Unreadable as error:
        print(f"::error::{error}", file=sys.stderr)
        return 2
    for line in found:
        print(f"::error::{lockfile}: {line}")
    if found:
        print(f"{len(found)} refusal(s) among {checked} package(s)", file=sys.stderr)
        return 1
    print(f"{checked} package(s), every one resolved on {REGISTRY} with an integrity")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
