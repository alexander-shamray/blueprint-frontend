# The lockfile check

`npm ci` installs exactly what `package-lock.json` names: each package from
the URL its `resolved` gives, held to the hash its `integrity` gives, with its
install scripts run. A commit that repoints a `resolved` and rewrites its
`integrity` to match therefore runs code from anywhere on every install, and
nothing else reads that: `npm audit` judges a package by name and version, the
`commits` job installs it, and the sweeps no longer slice the lockfile
(`.harness/sweep-rows.tsv`, blueprint-frontend#448). This check is the one
reader, and it reads every commit CI sees rather than a sample (#449).

```bash
py -3.12 tools/lockfile-check/lockfile_check.py                 # this checkout's lockfile
py -3.12 tools/lockfile-check/lockfile_check.py path/to/package-lock.json
cd tools/lockfile-check && py -3.12 -m unittest                 # its suite
```

Every entry under `packages` but the root is refused, and named, when:

| | |
|---|---|
| its `resolved` does not start with `https://registry.npmjs.org/` | a git, file, link, plain-`http` or other host's URL, including a host that only begins with the registry's name |
| its `resolved` is on the registry but is not its own tarball, `<name>/-/<basename>-<version>.tgz` with the name read from its path | any published package's tarball is on the registry, and `npm audit` would still judge it by this path's name and version |
| it carries a `name`, which makes it an alias | an alias installs another package at this path, so the rule above cannot say which tarball is its own; none exists today, and the first one wanted teaches the check which is meant |
| it has a `resolved` and no non-blank `integrity` | the tarball would be taken unhashed |
| it has no `resolved` and is not `inBundle: true` | npm would fetch it by name and version with no hash; a bundled package ships inside its parent's tarball, which the parent's `integrity` pins |
| it is not an object | nothing above can be read from it |

Exit 0 is a clean lockfile, 1 a refused one, each entry an `::error::` line,
and 2 a lockfile this check cannot read: missing, not JSON, a
`lockfileVersion` other than 3, a legacy `dependencies` map beside
`packages`, or no `packages` map at all. A lockfile it cannot read is never
reported clean, so an npm that writes a fourth version fails here until the
check learns it.

The suite's last class runs the check over this checkout's own lockfile,
which is the file the gate exists to read. `.github/workflows/ci.yml` runs
the suite and then the check in the `audit` job, before `npm ci`, and the
`commits` job runs the checked-out tree's copy of the check over each earlier
commit's lockfile before installing it; `docs/client-architecture.md` §14 says
why those two jobs.
