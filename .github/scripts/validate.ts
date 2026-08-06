#!/usr/bin/env node

// Catalog validation. No dependencies, no credentials, no install step:
//
//   node .github/scripts/validate.ts                      # structure only, whole catalog
//   node .github/scripts/validate.ts apps/me.thing.json   # + resolve its release
//   node .github/scripts/validate.ts --changed            # + resolve what this PR touched
//
// Two passes, because they cost different amounts. Structure, ids, namespace proof and
// rename links are checked for EVERY entry — that is string work over a few hundred small
// files, so there is no reason to be selective, and the rename checks need the whole set
// in memory anyway. The release ladder is resolved only for the entries you name, because
// each one costs GitHub API calls.
//
// This is deliberately the credential-free subset of what admission requires. Downloading
// the bundle, scanning it for secrets, enforcing the size caps and reading the manifest all
// happen in the private importer, after merge. Nothing here is a promise that an app is
// safe; it is a promise that the entry is well-formed and that the release is findable.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APPS = 'apps'

// One id segment: lowercase alphanumerics, hyphens only on the inside. Uppercase is
// rejected rather than folded — on a case-insensitive filesystem (macOS, where this is
// developed) Foo.json and foo.json collide in a checkout but not in git. The no-edge-hyphen
// rule is also what keeps the hostname encoding below reversible.
const SEGMENT = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const ID_RE = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`)
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

// The app is always the last segment, so segment count alone says which namespace an id
// claims: two is a GitHub login, three or more a reversed domain. Only the first can be
// proven today, by string comparison against the repo the entry already names.
const GITHUB_SEGMENTS = 2

// The zone hosted apps are served from. Only used to make the report readable.
const ROOT_DOMAIN = 'justapps.run'

// The longest DNS label, and so the longest encodable id.
const MAX_LABEL = 63

// Rung 4 (no tags at all — resolved from default-branch HEAD) is first-party only until
// the abuse model is proven. Everyone else pushes a tag; that is one command.
const FIRST_PARTY_OWNER = 'justfiles'

const FIELDS = ['repo', 'asset', 'status', 'to', 'formerIds', 'note']
const STATUSES = ['active', 'removed', 'renamed']

// A hosted app gets its own origin, and a wildcard certificate matches exactly one label, so
// the dotted id is inlined into a single one. This is IPFS's DNSLink encoding, which exists
// for the same reason: https://specs.ipfs.tech/http-gateways/subdomain-gateway/
//
// Escaping the hyphen rather than the dot keeps the common case clean — justfiles.draw is
// justfiles-draw, not justfiles--draw — while staying injective for the names that do carry
// hyphens, which GitHub logins and punycoded IDN domains both do.
//
// Kept in step with apps/runner/src/id.ts in the private monorepo, which decodes it. This
// repository has no dependencies by design, so the two implementations are duplicated rather
// than shared; the encoding is two replacements and is specified upstream.
const encodeLabel = (id: string) => id.replaceAll('-', '--').replaceAll('.', '-')

interface Entry {
	repo?: string
	asset?: string
	status?: string
	to?: string
	formerIds?: string[]
	note?: string
}

interface Loaded {
	id: string
	path: string // repo-relative, as it appears in a PR
	entry: Entry | null // null when the file did not parse
}

const failures: string[] = []
const warnings: string[] = []

function fail(path: string, message: string): void {
	failures.push(`${path}: ${message}`)
}

function warn(path: string, message: string): void {
	warnings.push(`${path}: ${message}`)
}

// ---------------------------------------------------------------- loading

function load(): Loaded[] {
	const loaded: Loaded[] = []
	let names: string[]
	try {
		names = readdirSync(resolve(ROOT, APPS)).sort()
	} catch {
		// Missing rather than empty: git does not track empty directories, so removing the
		// last entry takes apps/ with it. Report it and carry on — the deletion check below
		// is the one with something useful to say.
		fail(APPS, 'directory is missing')
		return loaded
	}
	for (const name of names) {
		const path = `${APPS}/${name}`
		if (!name.endsWith('.json')) {
			fail(path, 'only .json entries belong in apps/')
			continue
		}
		const id = name.slice(0, -'.json'.length)
		let entry: Entry | null = null
		try {
			// `null`, `0` and `"text"` are all valid JSON and none of them is an entry, so the
			// shape is settled here rather than left for a falsy check downstream to swallow.
			const parsed = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as unknown
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				fail(path, 'must contain a JSON object')
			} else {
				entry = parsed as Entry
			}
		} catch (error) {
			fail(path, `is not valid JSON — ${(error as Error).message}`)
		}
		loaded.push({ id, path, entry })
	}
	return loaded
}

// ---------------------------------------------------------------- structure

function checkStructure(item: Loaded): void {
	const { id, path, entry } = item
	if (!entry) return

	if (!ID_RE.test(id)) {
		fail(path, `"${id}" is not a lowercase <publisher>.<app> id`)
		return
	}
	if (id.split('.').length !== GITHUB_SEGMENTS) {
		fail(
			path,
			`"${id}" must be <github-login>.<app> — a reversed domain such as com.alice.notes ` +
				'needs DNS TXT proof, which is not implemented yet'
		)
		return
	}
	// The id is the hostname, so the DNS label limit binds the id. Checked here rather than
	// left to the runner: a merged entry that cannot be served is a worse failure than a
	// rejected pull request.
	const label = encodeLabel(id)
	if (label.length > MAX_LABEL) {
		fail(path, `"${id}" encodes to a ${label.length}-character host label; the DNS limit is ${MAX_LABEL}`)
		return
	}
	for (const key of Object.keys(entry)) {
		if (!FIELDS.includes(key)) fail(path, `unknown field "${key}"`)
	}
	if (entry.status !== undefined && !STATUSES.includes(entry.status)) {
		fail(path, `status must be one of ${STATUSES.join(', ')}`)
	}
	const status = entry.status ?? 'active'

	for (const key of ['repo', 'asset', 'to', 'note'] as const) {
		if (entry[key] !== undefined && typeof entry[key] !== 'string') {
			fail(path, `${key} must be a string`)
		}
	}
	if (entry.formerIds !== undefined) {
		if (!Array.isArray(entry.formerIds) || entry.formerIds.some((v) => typeof v !== 'string')) {
			fail(path, 'formerIds must be an array of strings')
		} else if (new Set(entry.formerIds).size !== entry.formerIds.length) {
			fail(path, 'formerIds contains duplicates')
		}
	}

	if (status === 'renamed') {
		if (!entry.to) fail(path, 'a renamed entry must name the id that replaced it in "to"')
		if (entry.repo) fail(path, 'a renamed entry is a tombstone — the repo belongs to the new id')
		if (entry.formerIds) fail(path, 'a tombstone does not carry formerIds; the new entry collects them')
	} else {
		if (entry.to) fail(path, '"to" is only for renamed entries')
		if (!entry.repo && status === 'active') fail(path, 'an active entry needs a repo')
		if (status === 'removed' && !entry.note) fail(path, 'a removed entry must say why in "note"')
	}

	if (entry.asset !== undefined) {
		if (!/^[^/\\]+\.zip$/.test(entry.asset)) fail(path, 'asset must be a *.zip filename, not a path')
		if (!entry.repo) fail(path, 'asset without a repo does nothing')
	}

	if (entry.repo) checkRepoField(item, entry.repo)
}

// The whole ownership model: the id's publisher names a GitHub account, and the entry points
// at a repository owned by that account. App names are scoped by publisher, so there is no
// name to squat, and so no transfer policy, no abandonment policy and no dispute queue.
function checkRepoField({ id, path }: Loaded, repo: string): void {
	if (!REPO_RE.test(repo)) {
		fail(path, `repo must be owner/name, got "${repo}"`)
		return
	}
	if (repo.endsWith('.git')) {
		fail(path, 'repo must not carry a .git suffix')
		return
	}
	const owner = repo.split('/')[0].toLowerCase()
	const publisher = id.split('.')[0]
	if (owner !== publisher) {
		fail(path, `publisher "${publisher}" does not own ${repo} — the id must be ${owner}.<app>`)
	}
}

// ---------------------------------------------------------------- renames

// Every tombstone must lead to a live entry that claims it, and every claim must have a
// tombstone behind it. Chains are collapsed: for a → b → c the entry for c lists both a
// and b, so a device offline since a jumps straight to c instead of walking the chain.
function checkRenames(all: Loaded[]): void {
	const byId = new Map(all.map((item) => [item.id, item]))
	const statusOf = (item: Loaded) => item.entry?.status ?? 'active'

	for (const item of all) {
		if (!item.entry || statusOf(item) !== 'renamed' || !item.entry.to) continue

		const chain = [item.id]
		let cursor = item
		while (statusOf(cursor) === 'renamed') {
			const next = byId.get(cursor.entry?.to ?? '')
			if (!next) {
				fail(item.path, `points at "${cursor.entry?.to}", which is not in the catalog`)
				break
			}
			if (chain.includes(next.id)) {
				fail(item.path, `rename chain loops back to ${next.id}`)
				break
			}
			chain.push(next.id)
			cursor = next
		}
		if (statusOf(cursor) === 'renamed') continue // already reported

		const terminal = cursor.entry?.formerIds ?? []
		for (const former of chain.slice(0, -1)) {
			if (!terminal.includes(former)) {
				fail(cursor.path, `must list "${former}" in formerIds — ${item.path} leads here`)
			}
		}
	}

	for (const item of all) {
		for (const former of item.entry?.formerIds ?? []) {
			const tombstone = byId.get(former)
			if (!tombstone) {
				fail(item.path, `formerIds names "${former}", which has no tombstone at ${APPS}/${former}.json`)
			} else if (statusOf(tombstone) !== 'renamed') {
				fail(item.path, `formerIds names "${former}", which is not a tombstone`)
			}
		}
	}
}

// Deleting an entry frees an id that installed devices already trust. Squatting an
// abandoned id is bad; squatting one with an install base is the worst outcome in the
// system, so the file stays and the status changes instead.
function checkDeletions(base: string): void {
	for (const path of gitDiff(base, 'D')) {
		fail(path, 'entries are never deleted — set status to "removed" or "renamed" instead')
	}
}

// ---------------------------------------------------------------- GitHub

class RateLimited extends Error {}

async function api(path: string): Promise<{ status: number; body: any }> {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		'user-agent': 'justfiles-app-catalog'
	}
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
	if (token) headers.authorization = `Bearer ${token}`

	const response = await fetch(`https://api.github.com${path}`, { headers })
	if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
		throw new RateLimited(
			token
				? 'GitHub rate limit reached.'
				: 'GitHub rate limit reached — unauthenticated requests are capped at 60/hour. Set GITHUB_TOKEN.'
		)
	}
	const body = response.status === 204 ? null : await response.json().catch(() => null)
	return { status: response.status, body }
}

const seg = (value: string) => encodeURIComponent(value)

interface Semver {
	major: number
	minor: number
	patch: number
	pre: string | null
}

// Normalise rather than demand. A leading v is stripped and missing components default to
// zero, so `v1`, `v1.2` and `1.2.3` all parse — Obsidian's exact-match rule produces a
// steady stream of failed submissions and buys nothing.
function semver(tag: string): Semver | null {
	const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag)
	if (!m) return null
	return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? null }
}

function compare(a: Semver, b: Semver): number {
	if (a.major !== b.major) return a.major - b.major
	if (a.minor !== b.minor) return a.minor - b.minor
	if (a.patch !== b.patch) return a.patch - b.patch
	if (a.pre === b.pre) return 0
	if (a.pre === null) return 1 // 1.0.0 outranks 1.0.0-rc.1
	if (b.pre === null) return -1
	return a.pre < b.pre ? -1 : 1
}

// Do not impose a filename convention: an author should be able to call their bundle
// draw.zip because that is what it is. A stale "asset" falls through and is reported
// rather than breaking imports until a catalog PR lands.
type Zip = { kind: 'zip'; name: string } | { kind: 'none' } | { kind: 'ambiguous'; zips: string[] }

function pickZip(assets: string[], want: string | undefined, report: (message: string) => void): Zip {
	if (want) {
		if (assets.includes(want)) return { kind: 'zip', name: want }
		report(`asset "${want}" is not on this release — falling through to the ladder`)
	}
	const zips = assets.filter((name) => name.toLowerCase().endsWith('.zip'))
	if (zips.length === 1) return { kind: 'zip', name: zips[0] }
	if (zips.length === 0) return { kind: 'none' }
	const conventional = zips.find((name) => name === 'app.zip')
	return conventional ? { kind: 'zip', name: conventional } : { kind: 'ambiguous', zips }
}

// The resolution ladder. Each rung asks strictly less of the author than the one above,
// and none of them asks for a catalog PR per release.
async function resolveLadder(item: Loaded): Promise<void> {
	const { path, entry } = item
	if (!entry?.repo || !REPO_RE.test(entry.repo)) return
	if ((entry.status ?? 'active') !== 'active') return

	const [owner, name] = entry.repo.split('/')
	const lines: string[] = []
	const say = (line: string) => lines.push(`  ${line}`)
	say(`✓ ${item.id} — namespace proven, ${owner} owns both the id and the repo`)
	say(`✓ hosted at ${encodeLabel(item.id)}.${ROOT_DOMAIN}`)

	const repo = await api(`/repos/${seg(owner)}/${seg(name)}`)
	if (repo.status === 404) {
		fail(path, `${entry.repo} is not reachable — it must exist and be public`)
		return
	}
	if (repo.status !== 200) {
		fail(path, `GitHub returned ${repo.status} for ${entry.repo}`)
		return
	}
	if (repo.body.private) {
		fail(path, `${entry.repo} is private`)
		return
	}

	// Rehosting a bundle needs an explicit redistribution licence. GitHub reports `other`
	// when it finds a LICENSE it cannot identify, and null when there is none at all.
	const licence = repo.body.license?.spdx_id ?? null
	if (!licence) {
		fail(path, `${entry.repo} has no LICENSE — JustApps cannot rehost a bundle it has no licence to serve`)
		return
	}
	if (licence === 'NOASSERTION') warn(path, 'licence could not be identified — a human has to read it')
	say(`✓ ${entry.repo} is public, ${licence}`)

	if (repo.body.archived) warn(path, `${entry.repo} is archived`)

	const latest = await api(`/repos/${seg(owner)}/${seg(name)}/releases/latest`)
	if (latest.status === 200) {
		const tag = latest.body.tag_name as string
		const sha = await commitFor(owner, name, tag)
		const assets = (latest.body.assets ?? []).map((asset: { name: string }) => asset.name)
		const zip = pickZip(assets, entry.asset, (message) => warn(path, message))
		if (zip.kind === 'ambiguous') {
			fail(path, `release ${tag} carries several zips (${zip.zips.join(', ')}) — set "asset" to name the bundle`)
			return
		}
		if (zip.kind === 'zip') say(`✓ rung 1 — ${zip.name} on release ${tag} (${sha})`)
		else say(`✓ rung 2 — repo tree at release tag ${tag} (${sha})`)
	} else {
		const { tags, truncated } = await allTags(owner, name)
		if (truncated) warn(path, 'more than 500 tags — only the first 500 were considered')
		const versions = tags
			.map((tag) => ({ tag, version: semver(tag.name) }))
			.filter((candidate) => candidate.version !== null)
		versions.sort((a, b) => compare(b.version as Semver, a.version as Semver))
		const newest = versions[0]

		if (newest) {
			say(`✓ rung 3 — repo tree at newest semver tag ${newest.tag.name} (${newest.tag.commit.sha.slice(0, 7)})`)
		} else if (owner.toLowerCase() === FIRST_PARTY_OWNER) {
			const branch = repo.body.default_branch
			const head = await api(`/repos/${seg(owner)}/${seg(name)}/commits/${seg(branch)}`)
			if (typeof head.body?.sha !== 'string') {
				fail(path, `${entry.repo} has no commits on ${branch}`)
				return
			}
			say(`✓ rung 4 (rolling) — ${branch} at ${head.body.sha.slice(0, 7)}`)
		} else {
			fail(
				path,
				`${entry.repo} has no releases and no semver tags. Rung 4 is first-party only for now — ` +
					'`git tag v1.0.0 && git push --tags` is enough to resolve at rung 3.'
			)
			return
		}
	}

	console.log(`${path}\n${lines.join('\n')}`)
}

interface Tag {
	name: string
	commit: { sha: string }
}

// The tags endpoint pages, and its order is not a promise, so "newest" is only correct
// once every page has been read. Capped, because an app repository with 500 tags is not
// the case worth spending unbounded API calls on.
async function allTags(owner: string, name: string): Promise<{ tags: Tag[]; truncated: boolean }> {
	const tags: Tag[] = []
	for (let page = 1; page <= 5; page++) {
		const response = await api(`/repos/${seg(owner)}/${seg(name)}/tags?per_page=100&page=${page}`)
		const batch = (response.body ?? []) as Tag[]
		tags.push(...batch)
		if (batch.length < 100) return { tags, truncated: false }
	}
	return { tags, truncated: true }
}

async function commitFor(owner: string, name: string, ref: string): Promise<string> {
	const commit = await api(`/repos/${seg(owner)}/${seg(name)}/commits/${seg(ref)}`)
	return String(commit.body?.sha ?? '???').slice(0, 7)
}

// ---------------------------------------------------------------- targets

// Arguments are never interpolated into a shell: git is invoked with an argv array, so a
// contributor-controlled filename is data, not code.
function gitDiff(base: string, filter: string): string[] {
	const out = execFileSync(
		'git',
		['diff', '--name-only', `--diff-filter=${filter}`, `${base}...HEAD`, '--', APPS],
		{ cwd: ROOT, encoding: 'utf8' }
	)
	return out.split('\n').filter(Boolean)
}

function targets(args: string[], all: Loaded[]): Loaded[] {
	const byPath = new Map(all.map((item) => [item.path, item]))
	let paths = args.filter((arg) => !arg.startsWith('--'))

	if (args.includes('--changed')) {
		const base = process.env.GITHUB_BASE_REF
		if (!base) {
			console.log('--changed: no GITHUB_BASE_REF, so nothing to compare against — structure only.\n')
		} else {
			checkDeletions(`origin/${base}`)
			paths = paths.concat(gitDiff(`origin/${base}`, 'd'))
		}
	}

	const chosen: Loaded[] = []
	for (const path of new Set(paths)) {
		const normalised = path.replace(/^\.\//, '')
		const item = byPath.get(normalised)
		if (item) chosen.push(item)
		else if (normalised.startsWith(`${APPS}/`)) fail(normalised, 'no such entry')
		else console.log(`skipping ${path} — not a catalog entry`)
	}
	return chosen
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2)
const all = load()
for (const item of all) checkStructure(item)
checkRenames(all)

try {
	for (const item of targets(args, all)) await resolveLadder(item)
} catch (error) {
	if (!(error instanceof RateLimited)) throw error
	console.error(`\n${error.message}`)
	process.exitCode = 1
}

// Deduped and sorted: the same missing formerId is reachable from several tombstones, and
// a contributor wants one line per problem, grouped by the file they have to open.
const problems = [...new Set(failures)].sort()
for (const warning of [...new Set(warnings)].sort()) console.log(`⚠ ${warning}`)
for (const problem of problems) console.error(`✗ ${problem}`)

if (problems.length > 0) {
	console.error(`\n${problems.length} problem(s) in ${all.length} entries.`)
	process.exitCode = 1
} else {
	console.log(`\n✓ ${all.length} entries, ${warnings.length} warning(s).`)
}
