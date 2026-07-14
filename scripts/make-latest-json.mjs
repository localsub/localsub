/**
 * Generates latest.json for the Tauri updater after `tauri build`.
 * Upload to the GitHub release alongside the installer and .sig file.
 *
 * Usage: node scripts/make-latest-json.mjs [release-notes]
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf-8"));
const version = conf.version;
const repo = "https://github.com/localsub/localsub";

const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `LocalSub_${version}_x64-setup.exe`;
const sig = readFileSync(join(bundleDir, `${installer}.sig`), "utf-8");

const latest = {
  version,
  notes: process.argv[2] ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: sig,
      url: `${repo}/releases/download/v${version}/${installer}`,
    },
  },
};

const out = join(bundleDir, "latest.json");
writeFileSync(out, JSON.stringify(latest, null, 2));
console.log(`[make-latest-json] Wrote ${out} (version ${version})`);
