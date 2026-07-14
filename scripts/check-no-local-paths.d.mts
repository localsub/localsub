export interface LocalPathHit {
  /** Absolute path of the offending file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first matched character. */
  column: number;
  /** Which pattern matched: `windows-user-home` | `posix-home` | `macos-home`. */
  pattern: string;
  /** The matched text, e.g. `C:\Users\admin`. */
  text: string;
}

export declare function findLocalPaths(root: string): LocalPathHit[];
