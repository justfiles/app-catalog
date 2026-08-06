# Security

## Reporting a malicious or compromised app

**If disclosing it publicly would arm an attacker** — an app abusing a runtime hole, a
capability escape, a live credential leaked in a published bundle — report it privately:

- GitHub → this repository's **Security** tab → **Report a vulnerability**, or
- <hi@xiaoxing.dev>.

Do not open a public issue and do not open a pull request. A pull request setting
`status: removed` announces the problem to everyone who is watching, including whoever is
exploiting it, before anything can be done about it.

**If it is already public and needs no embargo** — obvious malware, impersonation of another
app or author, a licence violation, a bundle carrying someone else's secrets — use the
[report an app](../../issues/new?template=report-app.yml) form. A public report is fine here
and gives the decision an audit trail.

Include the app id, the release or version, and what you observed. A link to the offending
code or a reproduction is worth more than a description.

Reports are triaged by one person, so expect an acknowledgement in days rather than hours.

### What happens next

1. Where the app is actively harmful, its published release is pulled first. That is an
   operational action and does not wait for a catalog change.
2. The entry is set to `status: removed` with a dated `note`. The entry is **not** deleted:
   the audit trail survives, and the id stays unclaimable so no one can inherit the trust of
   an app users already installed.
3. Stored artifacts are cleaned up separately, under retention, so the exact bytes that were
   served remain provable while the incident is being understood.

### Not in scope here

A bug in an app is the app's business — report it in the app's own repository. This is for
apps that are malicious, compromised, or being distributed in a way they have no right to be.

## The threat model of this repository

Catalog pull requests are untrusted input, and the repository is built so a hostile one has
almost nothing to reach for:

- Validation runs on `pull_request`, never `pull_request_target`, so a fork's code is never
  executed with write access to this repository.
- The workflow token is read-only. There are no Cloudflare, storage or production
  credentials in this repository or its Actions secrets, and no workflow here deploys or
  publishes anything.
- No dependencies and no `node_modules`. The validator is one file that a reviewer can read
  end to end, and CI runs it with Node's built-in TypeScript support.
- Contributor-controlled values reach the validator as `argv` and as URL-encoded path
  segments — never as shell text.
- Only actions published by GitHub are used by tag; any third-party action must be pinned to
  a full commit SHA.
- Merging an entry does not publish an app. The importer runs separately, with narrow
  staging permissions, and first publication is explicitly approved.

Every source repository and archive is treated as hostile downstream of this repository:
path traversal, absolute paths, symlinks, case-colliding names, archive bombs and file-count
limits are enforced at extraction, and bundles containing secrets are rejected. See
[CONTRIBUTING.md](CONTRIBUTING.md#what-your-bundle-must-contain).

## Known risks we are carrying deliberately

**A freed GitHub username.** A namespace is proven against a GitHub account, so if an author
renames or deletes their account, that login becomes available and the `owner/name` in an
entry can come to point at a different person's repository. The importer records each
repository's immutable numeric id alongside the entry and treats a change as a hard stop
requiring review, rather than trusting the path alone. Report it if you see an entry whose
repository has visibly changed hands.

**A checked entry is not a checked app.** Everything before merge is about the *entry*. The
bundle is validated after merge, by the importer, and no automated check is a judgement that
an app is trustworthy.

**One maintainer.** Response times are what one person can manage. If something is urgent and
you have had no reply, say so in a follow-up rather than assuming it was seen.
