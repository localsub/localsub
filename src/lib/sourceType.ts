import type { JobSourceType } from "../types";

/** Media containers accepted for the STT pipeline (drag & drop + file picker). */
export const MEDIA_EXTENSIONS = new Set([
  "mp4", "mkv", "avi", "mov", "webm",
  "mp3", "wav", "m4a", "flac", "ogg", "aac",
]);

/** Subtitle files accepted for the translate-only pipeline. */
export const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt"]);

export function getExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function isSubtitleFile(path: string): boolean {
  return SUBTITLE_EXTENSIONS.has(getExtension(path));
}

export function isAcceptedFile(path: string): boolean {
  const ext = getExtension(path);
  return MEDIA_EXTENSIONS.has(ext) || SUBTITLE_EXTENSIONS.has(ext);
}

/** Decide per-file how the pipeline should treat a job's input. */
export function getSourceType(path: string): JobSourceType {
  return isSubtitleFile(path) ? "subtitle" : "media";
}
