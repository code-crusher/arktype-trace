import { attest, contextualize } from "@ark/attest"
import { findPackageAncestors, readFile, readJson } from "@ark/fs"
import { deepEqual, match, ok } from "node:assert/strict"
import { join } from "node:path"

// OpenSSF Scorecard's Token-Permissions check scores a workflow 0 when it
// omits top-level permissions (they then default to write-all) and its
// Dangerous-Workflow check flags pull_request_target and workflow_run. Both
// are cheap to keep passing and expensive to notice after a release.
const root = findPackageAncestors().find(
	dir => readJson(join(dir, "package.json")).name === "ark"
)!
const workflowsDir = join(root, ".github", "workflows")

const workflowNames = ["pr", "publish", "codeql"] as const

const readWorkflow = (name: string): string =>
	readFile(join(workflowsDir, `${name}.yml`))

const lines = (contents: string): string[] =>
	contents.split("\n").map(line => line.replace(/\r$/, ""))

/** the block under a top-level `key:`, stopping at the next top-level key */
const topLevelBlock = (contents: string, key: string): string[] => {
	const all = lines(contents)
	const start = all.findIndex(line => line === `${key}:`)
	if (start === -1) return []
	const rest = all.slice(start + 1)
	const end = rest.findIndex(
		line => line.trim() !== "" && !line.startsWith(" ")
	)
	return end === -1 ? rest : rest.slice(0, end)
}

/** whether a `key:` is declared anywhere, whether it has a block or not */
const declaresKey = (contents: string, key: string): boolean =>
	lines(contents).some(line => line.trim() === `${key}:`)

contextualize(() => {
	it("declares top-level permissions in every workflow", () => {
		for (const name of workflowNames) {
			const contents = readWorkflow(name)
			// `permissions: {}` declares a block too, but writes it inline
			const declared =
				topLevelBlock(contents, "permissions").length > 0 ||
				contents.includes("\npermissions: {}\n")
			attest(declared).equals(true)
			// write-all is exactly what the check exists to catch
			attest(contents.includes("write-all")).equals(false)
		}
	})

	it("never uses a dangerous workflow trigger", () => {
		for (const name of workflowNames) {
			const contents = readWorkflow(name)
			attest(contents.includes("pull_request_target")).equals(false)
			attest(contents.includes("workflow_run")).equals(false)
		}
	})

	it("pins every action to a commit SHA", () => {
		for (const name of workflowNames) {
			for (const line of lines(readWorkflow(name))) {
				const uses = line.match(/^\s*uses:\s*(\S+)/)?.[1]
				// local composite actions are resolved from the checkout itself
				if (!uses || uses.startsWith("./")) continue
				match(uses, /^[^\s@]+@[\da-f]{40}$/, `${name}.yml: ${line}`)
			}
		}
	})

	it("detects dependency updates with dependabot", () => {
		const dependabot = readFile(join(root, ".github", "dependabot.yml"))
		match(dependabot, /^version:\s*2$/m)
		// the scorecard check only looks for the file, but the config is only
		// useful if it watches the ecosystems this repo uses
		deepEqual(
			Array.from(dependabot.matchAll(/package-ecosystem:\s*(\S+)/g), m => m[1]),
			["github-actions", "npm"]
		)
	})

	it("runs CodeQL on every change", () => {
		const codeql = readWorkflow("codeql")
		// the SAST check matches this action path verbatim, so it must stay
		// `github/codeql-action/analyze` while pinned to a commit
		match(codeql, /uses: github\/codeql-action\/analyze@[\da-f]{40}/)
		match(codeql, /languages: javascript-typescript/)
		ok(declaresKey(codeql, "pull_request"))
		ok(declaresKey(codeql, "push"))
	})

	it("keeps the docs' wasm out of the published packages", () => {
		// Binary-Artifacts flags onigasm.wasm, which the playground loads.
		// It only affects the scorecard because the docs are never published:
		// they are a private workspace package, and the published packages
		// ship only their `out` build.
		const docs = readJson(join(root, "ark", "docs", "package.json")) as {
			private?: boolean
		}
		attest(docs.private).equals(true)
	})
})
