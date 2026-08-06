# JustApps catalog

The list of apps JustApps knows about. One file per app, and the filename is the app id:

```
apps/justfiles.draw.json
```

```json
{
	"repo": "justfiles/app-draw"
}
```

That is the whole entry. There is no version field, no release strategy and no display
metadata, because everything else is discovered from the repository at import time or lives
in the app's own `manifest.json`. Duplicating it here would only go stale.

## Status: experimental — not yet accepting submissions

The public contract is being settled, and the importer that turns a merged entry into a
served app does not exist yet. Until it does, merging an entry would register an app that
nothing can install, so outside submissions are closed and only first-party entries land.

Watch this repository. When submissions open, [CONTRIBUTING.md](CONTRIBUTING.md) is already
the process — reading it now is not wasted, and the validator already runs.

Reporting a bad app is open now: see [SECURITY.md](SECURITY.md).

## How a release reaches users

Releases are **discovered, never declared**. You never open a pull request here to ship a
new version — merging your entry once is the last catalog interaction you have. The importer
resolves the newest release by walking down until something matches:

| # | Condition | What is served | Version |
| --- | --- | --- | --- |
| 1 | Latest release has a `*.zip` asset | that asset | release tag |
| 2 | Latest release, no zip asset | repository tree at that tag | release tag |
| 3 | No releases, tags exist | repository tree at newest semver tag | that tag |
| 4 | No tags at all | repository tree at default-branch `HEAD` | `YYYYMMDD.<sha7>` |

Rung 1 is the built path: CI zips your `dist/`. Rung 4 is the no-build path — an app written
in vanilla JavaScript ships with a text editor and a GitHub account. Rung 4 is first-party
only for now, so third-party apps need at least a tag; `git tag v1.0.0 && git push --tags`
is the entire requirement, and pushing a tag later graduates a rung-4 app to rung 3 with no
catalog change.

Bytes are snapshotted into JustApps storage at an immutable commit, then served from there.
Nothing is proxied from GitHub at request time, so a deleted upstream repository cannot take
a published app down, and the exact bytes served are always recoverable.

## Ids and ownership

An id is `<publisher>.<app>`, and the publisher has to be a namespace you can prove. Today
that means exactly one shape:

```
<your-github-user>.<app>
```

which is proven by a string comparison — `apps/alice.notes.json` must point at a repository
owned by `alice`. No DNS lookup, no HTTP callback, nothing that can flake.

Because a publisher is a GitHub account you already own, and app names are scoped inside it,
there is no name to squat: no transfer policy, no abandonment policy, no dispute queue. Two
authors can both ship `draw`. Moving to a branded namespace later (`com.aliceapps.notes`,
proven by a DNS `TXT` record) is planned, and is a supported rename rather than a
re-registration — [CONTRIBUTING.md](CONTRIBUTING.md#renaming-an-app) describes it.

## The id is also the hostname

A hosted app gets its own origin, and a wildcard certificate matches exactly one DNS label,
so the dotted id is inlined into one:

```
justfiles.draw   →   https://justfiles-draw.justapps.run
```

The encoding is [IPFS's DNSLink inlining](https://specs.ipfs.tech/http-gateways/subdomain-gateway/),
which exists for the same reason: every `-` becomes `--`, then every `.` becomes `-`. So
`nib-health.draw` is `nib--health-draw`. There is no separate slug to claim and nothing to
register — the hostname is a function of the id, which is a function of the filename.

Two things follow. Your id has to fit: the encoded label is capped at 63 characters, and the
validator checks that rather than letting a merged entry fail when someone tries to reach it.
And every app label contains a hyphen, so plain names like `www` and `api` stay with the
platform and can never be claimed.

## What is in here

| Path | What it is |
| --- | --- |
| `apps/*.json` | one entry per app; the filename is the id |
| `schema/app.schema.json` | the entry schema, for editors |
| `.github/scripts/validate.ts` | the checks — run it yourself before submitting |
| `.github/workflows/validate.yml` | the same script, on every pull request |

Run the checks with no install step and no credentials:

```sh
node .github/scripts/validate.ts                       # structure, whole catalog
node .github/scripts/validate.ts apps/you.thing.json   # + resolve its release
```

Node 24 runs the TypeScript directly.

## Licence

Two licences, because the repository holds two different things:

- **[LICENSE](LICENSE)** — MIT, covering this repository's code: the validator, the workflow
  and the schema.
- **[LICENSE-DATA](LICENSE-DATA)** — CC0 1.0, covering the catalog entries in `apps/`. The
  list of which apps exist should be freely reusable by anyone, including a competing client.

Neither licence says anything about the apps themselves. Each app is licensed by its own
repository, and JustApps only rehosts a bundle whose licence permits it.
