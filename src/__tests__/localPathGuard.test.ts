import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findLocalPaths } from "../../scripts/check-no-local-paths.mjs";

/**
 * Guards the guard. `check-no-local-paths.mjs` is the only thing standing
 * between a dev-machine path and a public installer, and it runs as part of
 * `npm run build`, so a silent regression in it is invisible until someone
 * downloads the release and reads our username out of `python312._pth`.
 */
describe("findLocalPaths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "localsub-guard-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (relPath: string, content: string) => {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
    return full;
  };

  it("passes a tree with no local paths", () => {
    write("python-embed/python312._pth", "python312.zip\n.\n\nimport site\n");
    write("integrity.json", '{"ffmpeg": {"url": "https://example.com/f.zip"}}');
    write("python-server/main.py", "from pathlib import Path\nROOT = Path(__file__).parent\n");
    expect(findLocalPaths(root)).toEqual([]);
  });

  it("catches the real incident: a Windows home path patched into python312._pth", () => {
    write(
      "python-embed/python312._pth",
      "python312.zip\n.\nC:\\Users\\admin\\AppData\\Roaming\\LocalSub\\python-env\n"
    );
    const hits = findLocalPaths(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("windows-user-home");
    expect(hits[0].line).toBe(3);
    expect(hits[0].file).toContain("python312._pth");
  });

  it("catches forward-slash Windows, Linux, and macOS home paths", () => {
    write("a.json", '{"p": "D:/Users/dev/env"}');
    write("b.py", 'CACHE = "/home/dev/.cache/localsub"');
    write("c.txt", "/Users/dev/Library/Application Support/LocalSub");

    const patterns = findLocalPaths(root)
      .map((h) => h.pattern)
      .sort();
    expect(patterns).toEqual(["macos-home", "posix-home", "windows-user-home"]);
  });

  it("catches a Windows path escaped for JSON, the shape integrity.json would leak", () => {
    write("integrity.json", '{"python": {"dest": "C:\\\\Users\\\\admin\\\\python-env"}}');
    const hits = findLocalPaths(root);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("windows-user-home");
  });

  it("reports D:/Users/dev once, not once per platform pattern", () => {
    write("a.txt", "D:/Users/dev/env");
    expect(findLocalPaths(root)).toHaveLength(1);
  });

  it("reports every occurrence, with line and column", () => {
    write("multi.txt", 'first\nC:\\Users\\alice x C:\\Users\\bob\n');
    const hits = findLocalPaths(root);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.text)).toEqual(["C:\\Users\\alice", "C:\\Users\\bob"]);
    expect(hits.map((h) => h.line)).toEqual([2, 2]);
    expect(hits[0].column).toBe(1);
    expect(hits[1].column).toBeGreaterThan(1);
  });

  it("ignores upstream binaries rather than flagging their byte soup", () => {
    write("python-embed/python3.dll", "C:\\Users\\admin\\whatever");
    write("python-embed/vcruntime.pyd", "/home/builder/src");
    expect(findLocalPaths(root)).toEqual([]);
  });

  it("does not flag relative paths, or a bare /home and /Users", () => {
    write("ok.py", 'p = "resources/python-embed"\nq = "../env/bin"\n');
    write("ok2.txt", "see /home and /Users for details\nC:\\Program Files\\LocalSub\n");
    expect(findLocalPaths(root)).toEqual([]);
  });

  it("treats a missing resource directory as clean, not as a failure", () => {
    expect(findLocalPaths(join(root, "never-provisioned"))).toEqual([]);
  });

  it("scans nested directories", () => {
    write("a/b/c/deep.json", '{"env": "C:\\\\Users\\\\admin\\\\env"}');
    expect(findLocalPaths(root)).toHaveLength(1);
  });
});
