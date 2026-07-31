export const GITHUB_REPO = "https://github.com/localsub/localsub"

/** Where `integrity.json` pins the ffmpeg build the app offers to install. */
export const FFMPEG_BUILDS = "https://www.gyan.dev/ffmpeg/builds/"
/** GPL v3 requires the source be obtainable; gyan's README names this repo. */
export const FFMPEG_SOURCE = "https://github.com/FFmpeg/FFmpeg"

/**
 * Where `tauri.log` and `server.log` live, in a form a user can paste into
 * Explorer or Win+R. Shown next to the "open log folder" button because the
 * install folder holds no logs — the first tester asked for logs looked there,
 * found nothing, and had nothing to send back.
 *
 * Must match `utils::log_dir()` in the Rust backend.
 */
export const LOG_DIR_HINT = "%APPDATA%\\LocalSub\\logs"
