// Sets the plugin's version everywhere it's recorded: plugin/manifest.json, the root manifest.json BRAT reads,
// versions.json, and plugin/package.json. Then commit, tag with the version, and push; GitHub builds the release.
//   node plugin/release.mjs 0.1.2
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {execSync} from "node:child_process"

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node plugin/release.mjs <major.minor.patch>")
  process.exit(1)
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"))
const writeJson = (p, v) => fs.writeFileSync(path.join(root, p), JSON.stringify(v, null, 2) + "\n")

const manifest = {...readJson("plugin/manifest.json"), version}
writeJson("plugin/manifest.json", manifest)
writeJson("manifest.json", manifest)
const versions = fs.existsSync(path.join(root, "versions.json")) ? readJson("versions.json") : {}
writeJson("versions.json", {...versions, [version]: manifest.minAppVersion})
writeJson("plugin/package.json", {...readJson("plugin/package.json"), version})
// The lockfile records the plugin's version too; CI's npm ci fails if it's out of step.
execSync("npm install --package-lock-only --no-audit --no-fund", {cwd: root, stdio: "ignore"})

console.log(`Version set to ${version}. Now:
  git add -A manifest.json versions.json package-lock.json plugin .github && git commit -m "Notebarn ${version}"
  git tag ${version} && git push && git push origin ${version}`)
