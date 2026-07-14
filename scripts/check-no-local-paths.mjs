/**
 * Fails the build if a developer's local path is about to be shipped.
 *
 * `src-tauri/resources/` is copied verbatim into the installer. Two of the files
 * in there are *written to* during development: `python-embed/python312._pth`
 * (patched at every launch with the pip-env directory) and the `python-server/`
 * copy. Building right after a dev run therefore bakes `C:\Users\<name>\...` into
 * a public artifact.
 *
 * This is not hypothetical. This repository restarted its git history because a
 * value nobody verified — a placeholder GitHub handle — reached the public repo.
 * The same class of mistake, one directory over.
 *
 * Usage:  node scripts/check-no-local-paths.mjs [rootDir ...]
 * Defaults to the bundled resource tree and the python-server sources that get
 * copied into it. Exit 1 with a report when anything matches.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, extname, basename, dirname, relative } from "path";
import { fileURLToPath } from "url";

/** Text formats we author or patch. Binaries are upstream artifacts. */
const TEXT_EXTENSIONS = new Set([".py", ".json", ".txt", ".lock", ".cfg", ".md", ".ini"]);

/** Extensionless files worth reading anyway. */
const TEXT_FILENAMES = new Set(["python312._pth"]);

/**
 * Absolute paths under a user's home directory, on any of the three platforms.
 * Anchored on the home root plus a name: a bare `/home` or a relative path is
 * not a leak.
 *
 * The Windows form accepts `\`, `\\`, and `/` as the separator — a path stored
 * in JSON arrives escaped (`"C:\\Users\\admin"`), which is exactly the shape a
 * leak into `integrity.json` would take.
 *
 * The POSIX forms refuse a preceding drive letter, so `D:/Users/dev` is one
 * Windows hit rather than a Windows hit and a macOS hit for the same text.
 */
const SEP = String.raw`(?:\\{1,2}|\/)`;
const PATTERNS = [
  { name: "windows-user-home", re: new RegExp(`[A-Za-z]:${SEP}Users${SEP}[^\\\\/\\s"'<>|]+`, "g") },
  { name: "posix-home", re: /(?<![A-Za-z]:)\/home\/[A-Za-z0-9._-]+/g },
  { name: "macos-home", re: /(?<![A-Za-z]:)\/Users\/[A-Za-z0-9._-]+/g },
];

// Nothing is excluded. `get-pip.py` is 2 MB of vendored upstream code and was
// checked: zero matches. An exception you do not need is a hole you cannot see.
function shouldRead(filePath) {
  const name = basename(filePath);
  if (TEXT_FILENAMES.has(name)) return true;
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Scan `root` and return every local-path hit as
 * `{ file, line, column, pattern, text }`. Missing `root` yields no hits — a
 * resource dir that has not been provisioned yet is not a failure.
 */
export function findLocalPaths(root) {
  if (!existsSync(root)) return [];
  const hits = [];
  for (const file of walk(root)) {
    if (!shouldRead(file)) continue;
    let content;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // unreadable / not valid utf-8: not a text file we author
    }
    content.split(/\r?\n/).forEach((lineText, i) => {
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lineText)) !== null) {
          hits.push({
            file,
            line: i + 1,
            column: m.index + 1,
            pattern: name,
            text: m[0],
          });
        }
      }
    });
  }
  return hits;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  // `python-server/` is scanned at its source, not only where sync-python copies
  // it: the copy is gitignored, so CI would otherwise scan almost nothing.
  const defaultRoots = [join(repoRoot, "src-tauri", "resources"), join(repoRoot, "python-server")];
  const roots = process.argv.length > 2 ? process.argv.slice(2) : defaultRoots;
  const hits = roots.flatMap((r) => findLocalPaths(r));

  if (hits.length === 0) {
    console.log(`[check-no-local-paths] clean: ${roots.join(", ")}`);
    process.exit(0);
  }

  console.error(
    `[check-no-local-paths] ${hits.length} local path(s) would ship in the installer:\n`
  );
  for (const h of hits) {
    console.error(`  ${relative(repoRoot, h.file)}:${h.line}:${h.column}  [${h.pattern}]`);
    console.error(`    ${h.text}`);
  }
  console.error(
    `\nThese are developer paths. Regenerate the resources (scripts/download-python-embed.ps1)\nbefore building, and do not commit them.`
  );
  process.exit(1);
}
