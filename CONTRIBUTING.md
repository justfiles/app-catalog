# Contributing

> **Submissions are not open yet.** The importer that turns a merged entry into a served app
> is still being built, so an entry merged today would register an app nothing can install.
> This document is the process that will apply when submissions open, and the validator it
> describes already runs. See [README.md](README.md#status-experimental--not-yet-accepting-submissions).

## The ladder of things you have to do

Almost nothing. Publish an app repository, open one pull request adding one file, and never
touch this repository again — not for version 1.1, not for 2.0, not ever. That is the design
goal, and every rule below exists only where dropping it would let someone hijack an id or
get JustApps to serve bytes it has no right to serve.

## Submitting an app

1. **Publish the app in its own public GitHub repository**, with a LICENSE that permits
   redistribution. JustApps rehosts your bundle; without a licence it cannot.
2. **Cut a release** — see [Publishing releases](#publishing-releases).
3. **Add one file** to `apps/`, named after your app id, containing the repository pointer:

   ```sh
   echo '{ "repo": "alice/notes" }' > apps/io.github.alice.notes.json
   ```

4. **Run the validator** and fix anything it reports:

   ```sh
   node .github/scripts/validate.ts apps/io.github.alice.notes.json
   ```

5. **Open a pull request from your own GitHub account** — the account named in the id. That
   is how the namespace is proven, so a pull request opened by someone else cannot be merged.

## The entry

| Field | When | What |
| --- | --- | --- |
| `repo` | required, unless renamed | `owner/name` on GitHub. The owner must match your id's namespace. |
| `asset` | rare | Names the bundle when a release carries several archives. See [below](#which-asset). |
| `status` | on retirement | `active` (the default — omit it), `removed`, or `renamed`. |
| `to` | renamed only | The id that replaced this one. |
| `formerIds` | after a rename | Every id this app has previously been published under. |
| `note` | required on `removed` | Why, in one line. |

Nothing else is accepted, and unknown fields are rejected. In particular there is **no
version field** and no display metadata: name, description, icon and capabilities are read
from your `manifest.json` at import time, so they update when you release, not when someone
merges a pull request here.

## Ids

Your id is the filename, minus `.json`. There is no `id` field to contradict it, and the
filesystem makes two entries claiming the same id impossible.

- **Lowercase.** `Notes.json` and `notes.json` are the same file on macOS but different
  files in git, so uppercase is rejected outright rather than left to surface later.
- **Reverse-DNS**, dot-separated, hyphens allowed inside a segment.
- **`io.github.<user>.<app>`** — the only provable namespace today. `<user>` must own the
  repository the entry points at.

Custom domains (`com.aliceapps.notes`, proven by a DNS `TXT` record) are planned, and are
deliberately not a launch feature: everyone is served by `io.github.*`, and moving later is
a supported [rename](#renaming-an-app).

The id is your app's identity on every device that installs it — it keys stored data and
granted capabilities. Choose one you can live with, and change it only through a rename.

## Publishing releases

You do not tell the catalog about a release. It is discovered by walking down this ladder
until something matches:

| # | Condition | What is served | Version |
| --- | --- | --- | --- |
| 1 | Latest release has a `*.zip` asset | that asset | release tag |
| 2 | Latest release, no zip asset | repository tree at that tag | release tag |
| 3 | No releases, tags exist | repository tree at newest semver tag | that tag |
| 4 | No tags at all | repository tree at default-branch `HEAD` | `YYYYMMDD.<sha7>` |

**Rung 4 is first-party only for now.** Third-party apps need at least a tag, which costs one
command — `git tag v1.0.0 && git push --tags` — and pins every release to an immutable ref
while the abuse model is still unproven. This restriction is expected to lift.

Tags are normalised, not policed: a leading `v` is stripped, and `v1`, `v1.2` and `v1.2.3`
all parse. If your tag and your `manifest.json` disagree about the version, the **tag wins**
— it is the immutable one — and the mismatch is reported rather than failing the import.

### A release workflow

If your app has a build step, rung 1 is what you want, and the whole workflow is about
fifteen lines. This is [app-draw](https://github.com/justfiles/app-draw)'s, trimmed — it
releases whenever `package.json`'s version has no matching tag, so shipping is a version bump
and a merge:

```yaml
name: release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write # create the tag and the release
      id-token: write # sign the provenance attestation
      attestations: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      # Zip the CONTENTS of dist/, so manifest.json lands at the archive root.
      - run: cd dist && zip -qr ../draw.zip .

      - uses: actions/attest@v4
        with:
          subject-path: draw.zip

      - env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "v$VERSION" draw.zip --target "$GITHUB_SHA" --generate-notes
```

Two details worth copying rather than rediscovering:

- **`--target "$GITHUB_SHA"`** pins the tag to the commit that was actually built and
  attested. Without it, a push racing the job produces a tag whose source is not the source
  the attestation covers.
- **`actions/attest@v4`**, not `actions/attest-build-provenance`: as of v4 the latter is a
  thin wrapper over the former, and GitHub's own docs point new workflows at `attest`.

A reusable `justfiles/release` workflow is planned so this shrinks to four lines. It does not
exist yet; copy the above until it does.

### Attestation

A zip has no verifiable relationship to the commit recorded next to it — anyone who can
attach a release asset can attach anything. So **rung 1 requires a build-provenance
attestation**, which the importer verifies against the Sigstore bundle. This is a stronger
stance than npm's opt-in provenance, and it is the only reason rung 1 can be trusted as much
as the tree-based rungs, where the served bytes simply *are* the source at a commit.

Rungs 2–4 need no attestation: with no build step there is no gap to attest.

### Which asset

There is no filename convention. Call your bundle whatever describes it. When a release has
a zip, it is chosen like this:

| # | Rule |
| --- | --- |
| 1 | Your entry sets `"asset"` and an asset matches that name exactly |
| 2 | Exactly one `*.zip` on the release — it must be the one |
| 3 | Several zips, one of them named `app.zip` |
| 4 | Otherwise it fails, listing what it found |

Rung 2 is the common case and costs you nothing. Only set `"asset"` if you publish several
archives on one release. If you set it and later rename the file, imports do **not** break:
a stale `asset` falls through the rest of the ladder and is reported.

## What your bundle must contain

The bundle is the zip's contents, or the repository tree — either way it is searched for
`manifest.json` at `/`, `/dist`, `/build` and `/src`, and the directory it is found in
becomes the bundle root. An optional `"root"` in the manifest overrides that. You should not
need it.

Limits, enforced on the extracted bundle:

| Limit | Value | Why |
| --- | --- | --- |
| Total extracted size | ~50 MB | What a decompression bomb attacks, and what has to fit in a Worker isolate. Compressed size is not capped. |
| File count | ~500 | Same. |
| Any single file | ~20 MB | Files stream straight into storage, so peak memory is the largest one. |
| `app.js` | ~1 MB | It is the only file that becomes executable Worker code. |

`app.js` and `gui.js` carry completely different risk and do not share a limit. A large
`gui.js` is fine — app-draw's is 9.8 MB, almost all of it a bundled Excalidraw — because it
is an inert static asset. The reducer that actually runs is 7.7 KB.

**Bundles containing secrets are rejected outright**, with no partial import:

```
.env*    *.pem    id_rsa*    .npmrc    *.key
```

This matters most on the tree-based rungs. A build step is an accidental filter; a raw
repository tree has none, so a committed local-dev `.env` would otherwise be rehosted at a
public URL on a JustApps domain.

## Renaming an app

Renaming is designed in — it is what makes `io.github.*` safe to recommend as a starting
point. One pull request, two files:

```json
// apps/com.aliceapps.notes.json  — the new entry, claiming its history
{ "repo": "alice/notes", "formerIds": ["io.github.alice.notes"] }
```

```json
// apps/io.github.alice.notes.json  — the old entry, now a tombstone
{ "status": "renamed", "to": "com.aliceapps.notes" }
```

**Never delete the old file.** Deleting it makes the old id claimable again — and it is an id
that installed devices already trust. Squatting an abandoned id is bad; squatting one with an
install base is the worst outcome this catalog can produce. The tombstone is what keeps the
id unclaimable, and the validator rejects any pull request that deletes an entry.

Rules:

- **Renames always get human review.** This is the highest-risk operation here, precisely
  because it is how an established app's install base would be hijacked. Nothing auto-merges.
- **Both namespaces must be provable by you**, the pull-request author: the old one against
  the entry's current repository, the new one against the new repository. If you are also
  moving the app to a different repository, do that in a *separate, earlier* pull request so
  the old proof still holds when it is checked.
- **Chains collapse.** For `a → b → c`, the entry for `c` lists both `a` and `b`, so a device
  offline since `a` lands directly on `c`. The validator checks that every tombstone leads to
  an entry claiming it, and that every claimed id has a tombstone behind it.
- **A manifest that still says the old id is a warning, not a failure.** Older releases
  naturally name the old id. The catalog filename wins.

On device, a rename migrates installed state — data and granted capabilities move to the new
id rather than the app vanishing and an unrelated one appearing. That is why the tombstone and
`formerIds` are load-bearing rather than bookkeeping.

## Removing an app

Also not a deletion:

```json
{ "repo": "alice/calendar", "status": "removed", "note": "malware, 2026-08-01" }
```

The entry stays, so the audit trail survives and the id stays unclaimable. Removal delists
the app; it is a separate, explicit operation from cleaning up stored artifacts.

If you want your own app delisted, open a pull request setting `status` and `note`. If you
are reporting someone else's, do not open a pull request — see [SECURITY.md](SECURITY.md).

## What is checked, and by what

`node .github/scripts/validate.ts` runs the same checks CI runs. It needs no credentials and
no install step, and it is the complete list of what can be checked before merge:

- the filename is a lowercase reverse-DNS id in a provable namespace;
- the JSON parses, has no unknown fields, and satisfies its status's rules;
- the namespace owns the repository the entry names;
- no entry file is being deleted;
- renames link both ways, chains terminate, and no chain loops;
- the repository is reachable, public and licensed;
- the ladder resolves to a real release, tag or commit — and, on rung 1, to exactly one
  identifiable zip.

Everything about the *bytes* — the manifest, the secret scan, the size caps, the attestation
— happens in the private importer after merge, because it means downloading and extracting an
untrusted archive. A green check here means the entry is well-formed and the release is
findable. It is not a statement that the app is safe.

Set `GITHUB_TOKEN` if you hit the unauthenticated GitHub rate limit of 60 requests an hour:

```sh
GITHUB_TOKEN=$(gh auth token) node .github/scripts/validate.ts apps/io.github.you.thing.json
```

The repository has no dependencies and no `node_modules`, so there is nothing to install and
nothing for a reviewer to have to trust. Your editor may want `@types/node` installed globally
to resolve the `node:` imports; nothing in CI does.

## What the maintainer reviews

Everything mechanical is done by the time a human looks, so review is one judgement call:
**is this a legitimate app?** Not whether the JSON is right, not whether the tag exists, not
whether you own the namespace — those are already green or the pull request is already red.

Updates to an existing entry auto-merge when everything is green. Human review is required
for a new app, and for any change to the id, the source repository, ownership, entry points
or requested capabilities.

Merging registers the app. It does not publish it: first publication is separately approved,
after the bundle has been downloaded, validated and staged.
