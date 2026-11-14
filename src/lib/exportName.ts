/**
 * File name (no extension) for exported subtitles: the source media's name,
 * so "Talk.mp4" exports as "Talk.srt". Both the automatic export at the end
 * of a job and the editor's Export button use it, so the manual export
 * replaces the automatic one instead of writing a file named after the job id.
 */
export function exportBaseName(filePath: string | null | undefined, fallback: string): string {
  const base = filePath?.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "")
  return base && base.trim() ? base : fallback
}
