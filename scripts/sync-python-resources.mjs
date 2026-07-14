/**
 * Syncs python-server source files to src-tauri/resources/python-server/
 * for production bundling. Excludes tests, __pycache__, dev-only files.
 */
import { cpSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "python-server");
const dest = join(root, "src-tauri", "resources", "python-server");

const EXCLUDE = new Set([
  "__pycache__",
  ".pytest_cache",
  "venv",
  "requirements-dev.txt",
]);

function shouldInclude(name) {
  if (EXCLUDE.has(name)) return false;
  if (name.startsWith("test_")) return false;
  if (name.endsWith(".pyc")) return false;
  return true;
}

// Clean and recreate dest
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// Copy matching files
const entries = readdirSync(src);
let copied = 0;
for (const entry of entries) {
  if (!shouldInclude(entry)) continue;
  cpSync(join(src, entry), join(dest, entry), { recursive: true });
  copied++;
}

console.log(`[sync-python-resources] Copied ${copied} files to ${dest}`);
