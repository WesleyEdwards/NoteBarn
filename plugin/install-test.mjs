// Copies the built plugin into the test-sync vault, where Obsidian loads it from.
import fs from "node:fs"
import path from "node:path"

const vault = path.resolve("../test-sync")
const target = path.join(vault, ".obsidian", "plugins", "notebarn")
fs.mkdirSync(target, {recursive: true})
for (const file of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(file, path.join(target, file))
console.log(`Installed into ${target}`)
