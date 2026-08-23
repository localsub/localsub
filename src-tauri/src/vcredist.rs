//! Microsoft Visual C++ runtime: detection, staged install, and what happened
//! last time.
//!
//! The bundled embeddable CPython ships `vcruntime140.dll` and
//! `vcruntime140_1.dll` but not the C++ standard library. ctranslate2 (STT),
//! llama_cpp (translation) and onnxruntime (diarization, embedding gate) all
//! import `msvcp140.dll`; llama_cpp's ggml also wants `vcomp140.dll`, and
//! onnxruntime additionally wants `msvcp140_1.dll`. None of them vendor a copy.
//! On a machine without the runtime installed, every AI backend fails to load.
//!
//! This is deliberately *not* wired into the setup marker. The runtime is
//! machine-global state the user can add or remove behind our back, so it is
//! re-detected on every launch instead of being remembered as "done". That is
//! what keeps a declined elevation prompt recoverable: setup runs once, but
//! this check runs forever.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::setup_manager::SetupErrorKind;

/// Runtime DLLs the bundled Python's native backends link against, none of
/// which the embeddable distribution ships.
pub const REQUIRED_DLLS: [&str; 3] = ["msvcp140.dll", "msvcp140_1.dll", "vcomp140.dll"];

/// DLLs whose absence stops the two features the app exists for.
///
/// `msvcp140_1.dll` is deliberately absent from this list: only onnxruntime
/// needs it, so losing it costs diarization and the semantic quality gate, not
/// STT or translation.
const CORE_DLLS: [&str; 2] = ["msvcp140.dll", "vcomp140.dll"];

// -- Detection ---------------------------------------------------------------

/// Can the loader resolve `dll` from the system directory?
///
/// `LOAD_LIBRARY_SEARCH_SYSTEM32` rather than a bare name on purpose: it asks
/// the exact question we mean -- "is the machine-wide runtime installed" -- and
/// cannot be answered by a stray copy sitting in the working directory, which a
/// plain `LoadLibraryW` would happily load.
#[cfg(target_os = "windows")]
fn system_can_load(dll: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;

    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

    let wide: Vec<u16> = std::ffi::OsStr::new(dll)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryExW(
                lpLibFileName: *const u16,
                hFile: *mut core::ffi::c_void,
                dwFlags: u32,
            ) -> *mut core::ffi::c_void;
            fn FreeLibrary(hLibModule: *mut core::ffi::c_void) -> i32;
        }

        let handle = LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
        if handle.is_null() {
            false
        } else {
            FreeLibrary(handle);
            true
        }
    }
}

/// Non-Windows builds have nothing to check: the runtime question is a Windows
/// one and the app only ships there.
#[cfg(not(target_os = "windows"))]
fn system_can_load(_dll: &str) -> bool {
    true
}

/// What the machine is missing right now, freshly probed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuntimeStatus {
    /// Names from [`REQUIRED_DLLS`] the loader could not resolve.
    pub missing: Vec<String>,
    /// STT and translation cannot run at all. Drives the loud UI, as opposed to
    /// the quiet note shown when only diarization is affected.
    pub core_blocked: bool,
}

/// Probes the runtime. Cheap enough to call on every launch -- three
/// `LoadLibraryEx` calls against already-mapped system DLLs.
pub fn status() -> RuntimeStatus {
    let missing: Vec<String> = REQUIRED_DLLS
        .iter()
        .filter(|dll| !system_can_load(dll))
        .map(|dll| (*dll).to_string())
        .collect();
    let core_blocked = missing.iter().any(|m| CORE_DLLS.contains(&m.as_str()));
    RuntimeStatus {
        missing,
        core_blocked,
    }
}

// -- Attempt record ----------------------------------------------------------

/// How far an install attempt got. Reported live and persisted, so a retry can
/// say where the last one stopped instead of offering a blank button.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Fetching VC_redist.x64.exe.
    Download,
    /// Checking it against the pin in integrity.json.
    Verify,
    /// Windows is asking the user to allow the installer to run.
    Consent,
    /// Microsoft's installer is running.
    Install,
    /// Confirming the DLLs actually resolve now.
    Recheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    /// Installed, but the runtime only becomes usable after a restart.
    RebootRequired,
    /// The user said No at the elevation prompt. Not an error: the app says so
    /// and leaves the button in place.
    Declined,
    Failed,
}

/// The last install attempt, as persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub stage: Stage,
    /// `None` means the attempt never reached an end: the app was closed or
    /// killed while it was running.
    ///
    /// This is only distinguishable because the record is written when the
    /// attempt *starts* and updated when it finishes. Writing it only at the
    /// end would collapse "interrupted" and "declined" into the same blank.
    pub outcome: Option<Outcome>,
    /// Machine-readable failure class, reusing setup's vocabulary.
    pub kind: Option<String>,
    /// Free text for the log and the detail line; never the sole signal.
    pub detail: Option<String>,
    /// Whatever Microsoft's installer returned, when it ran.
    pub exit_code: Option<i32>,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    /// Unix seconds. The frontend formats it, so Rust needs no date dependency.
    pub at_epoch_secs: u64,
}

impl Attempt {
    fn starting(stage: Stage) -> Self {
        Self {
            stage,
            outcome: None,
            kind: None,
            detail: None,
            exit_code: None,
            bytes_downloaded: 0,
            bytes_total: 0,
            at_epoch_secs: now_epoch_secs(),
        }
    }
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn attempt_path() -> Result<PathBuf, AppError> {
    Ok(crate::utils::app_data_dir()?.join("vcredist-attempt.json"))
}

/// The last attempt, or None if there has never been one.
///
/// A corrupt file reads as None: this record is an explanatory nicety, and
/// failing to parse it must never stand between the user and the retry button.
pub fn read_attempt() -> Option<Attempt> {
    let path = attempt_path().ok()?;
    if !path.exists() {
        return None;
    }
    match crate::utils::read_json_file::<Attempt>(&path) {
        Ok(attempt) => Some(attempt),
        Err(e) => {
            log::warn!("[vcredist] ignoring unreadable attempt record: {}", e);
            None
        }
    }
}

fn save_attempt(attempt: &Attempt) {
    match attempt_path() {
        Ok(path) => {
            if let Err(e) = crate::utils::atomic_write(&path, attempt) {
                log::warn!("[vcredist] could not persist attempt record: {}", e);
            }
        }
        Err(e) => log::warn!("[vcredist] no path for attempt record: {}", e),
    }
}

/// Live progress for the UI. Structured, not prose: the wording is the
/// frontend's job so it can be translated.
#[derive(Debug, Clone, Serialize)]
struct Progress {
    stage: Stage,
    bytes_downloaded: u64,
    bytes_total: u64,
}

fn emit_progress(app: &AppHandle, attempt: &Attempt) {
    let _ = app.emit(
        "vcredist-progress",
        Progress {
            stage: attempt.stage,
            bytes_downloaded: attempt.bytes_downloaded,
            bytes_total: attempt.bytes_total,
        },
    );
}

// -- Elevated launch ---------------------------------------------------------

/// Exit code Windows uses for "the user dismissed the elevation prompt".
pub const ERROR_CANCELLED: i32 = 1223;
/// The installer ran; a reboot is needed before the runtime is usable.
const ERROR_SUCCESS_REBOOT_REQUIRED: i32 = 3010;
/// A newer runtime is already present. Nothing to do, and not a failure.
const ERROR_PRODUCT_VERSION: i32 = 1638;

/// Escapes a string for a PowerShell single-quoted literal.
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Builds the PowerShell one-liner that runs the installer elevated.
///
/// Split out from [`run_elevated`] so the quoting and the cancel mapping can be
/// tested without launching anything.
fn elevate_script(exe_path: &str) -> String {
    format!(
        "try {{ $p = Start-Process -FilePath '{}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode }} catch {{ exit {} }}",
        ps_quote(exe_path),
        ERROR_CANCELLED
    )
}

/// Runs the redistributable with elevation and returns its exit code.
///
/// `std::process::Command` cannot do this: the installer's manifest requires
/// elevation, so `CreateProcess` refuses outright with ERROR_ELEVATION_REQUIRED
/// (740) rather than prompting. Only a shell verb raises the consent dialog,
/// hence `Start-Process -Verb RunAs`.
///
/// Declining the prompt makes `Start-Process` throw, which the script catches
/// and normalises to [`ERROR_CANCELLED`], so the caller can tell "user said no"
/// apart from "installer failed".
#[cfg(target_os = "windows")]
fn run_elevated(exe: &std::path::Path) -> Result<i32, AppError> {
    let script = elevate_script(&exe.to_string_lossy());
    let output = crate::utils::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| AppError::Setup(format!("Failed to launch the installer: {}", e)))?;

    Ok(output.status.code().unwrap_or(-1))
}

#[cfg(not(target_os = "windows"))]
fn run_elevated(_exe: &std::path::Path) -> Result<i32, AppError> {
    Err(AppError::Setup(
        "The Visual C++ runtime is a Windows component".into(),
    ))
}

// -- Install -----------------------------------------------------------------

/// Downloads, verifies, and installs the runtime, recording every stage.
///
/// A declined prompt returns `Ok(Outcome::Declined)` rather than an `Err`: it is
/// a choice the user is allowed to make, and the caller should offer the button
/// again instead of showing a failure.
pub async fn install(app: &AppHandle, cancel: CancellationToken) -> Result<Outcome, AppError> {
    let entry = crate::integrity::load_integrity_manifest(app)?.vc_redist;
    let dest = crate::utils::app_data_dir()?.join("VC_redist.x64.exe");

    // -- Download --
    let mut attempt = Attempt::starting(Stage::Download);
    save_attempt(&attempt);
    emit_progress(app, &attempt);
    log::info!("[vcredist] downloading {}", entry.url);

    let client = reqwest::Client::new();
    let progress_app = app.clone();
    let download = crate::model_downloader::download_file(
        &client,
        &entry.url,
        &dest,
        cancel.clone(),
        move |downloaded, total, _speed, _eta| {
            let _ = progress_app.emit(
                "vcredist-progress",
                Progress {
                    stage: Stage::Download,
                    bytes_downloaded: downloaded,
                    bytes_total: total,
                },
            );
        },
    )
    .await;

    // Recorded even on failure: "stopped at 12 of 24 MB" is the difference
    // between a useful retry screen and a blank one.
    attempt.bytes_downloaded = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    attempt.bytes_total = attempt.bytes_downloaded;

    if let Err(e) = download {
        return Err(finish_failed(
            &mut attempt,
            SetupErrorKind::Network,
            e.to_string(),
            None,
        ));
    }

    // -- Verify --
    attempt.stage = Stage::Verify;
    save_attempt(&attempt);
    emit_progress(app, &attempt);

    if !crate::integrity::verify_sha256(&dest, &entry.sha256).await? {
        // Leaving the bad file behind would make the next attempt resume onto
        // it and fail the same way forever.
        let _ = std::fs::remove_file(&dest);
        return Err(finish_failed(
            &mut attempt,
            SetupErrorKind::Integrity,
            "The downloaded installer did not match its pinned sha256".into(),
            None,
        ));
    }

    // -- Consent, then Install --
    // These are one blocking call, so the stage stays Consent while it runs and
    // only moves to Install once the exit code proves the prompt was accepted.
    attempt.stage = Stage::Consent;
    save_attempt(&attempt);
    emit_progress(app, &attempt);

    let code = run_elevated(&dest)?;
    log::info!("[vcredist] installer exit code {}", code);

    if code == ERROR_CANCELLED {
        attempt.outcome = Some(Outcome::Declined);
        attempt.exit_code = Some(code);
        save_attempt(&attempt);
        emit_progress(app, &attempt);
        log::info!("[vcredist] user declined the elevation prompt");
        return Ok(Outcome::Declined);
    }

    attempt.stage = Stage::Install;
    attempt.exit_code = Some(code);
    save_attempt(&attempt);
    emit_progress(app, &attempt);

    let reboot_required = code == ERROR_SUCCESS_REBOOT_REQUIRED;
    if !(code == 0 || reboot_required || code == ERROR_PRODUCT_VERSION) {
        return Err(finish_failed(
            &mut attempt,
            SetupErrorKind::Unknown,
            format!("The Visual C++ installer failed with code {}", code),
            Some(code),
        ));
    }

    // -- Recheck --
    // The installer reporting success is not the same as the loader being able
    // to resolve the DLLs, and only the second one matters to us.
    attempt.stage = Stage::Recheck;
    save_attempt(&attempt);
    emit_progress(app, &attempt);

    let after = status();
    if !after.missing.is_empty() && !reboot_required {
        return Err(finish_failed(
            &mut attempt,
            SetupErrorKind::Unknown,
            format!(
                "The installer reported success but {} still cannot be loaded",
                after.missing.join(", ")
            ),
            Some(code),
        ));
    }

    let outcome = if reboot_required || !after.missing.is_empty() {
        Outcome::RebootRequired
    } else {
        Outcome::Ok
    };
    attempt.outcome = Some(outcome);
    save_attempt(&attempt);
    emit_progress(app, &attempt);

    // 25 MB of cache with no further use.
    let _ = std::fs::remove_file(&dest);

    log::info!("[vcredist] install finished: {:?}", outcome);
    Ok(outcome)
}

/// Stamps the failure onto the attempt, persists it, and builds the error.
fn finish_failed(
    attempt: &mut Attempt,
    kind: SetupErrorKind,
    detail: String,
    exit_code: Option<i32>,
) -> AppError {
    attempt.outcome = Some(Outcome::Failed);
    attempt.kind = Some(kind.as_str().to_string());
    attempt.detail = Some(detail.clone());
    attempt.exit_code = exit_code;
    save_attempt(attempt);
    log::error!(
        "[vcredist] failed at {:?} ({}): {}",
        attempt.stage,
        kind.as_str(),
        detail
    );
    AppError::Setup(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list the UI reasons about must stay in sync with the split between
    /// "app is unusable" and "one feature is off".
    #[test]
    fn core_dlls_are_a_subset_of_required_dlls() {
        for dll in CORE_DLLS {
            assert!(
                REQUIRED_DLLS.contains(&dll),
                "{dll} is treated as core but is never probed"
            );
        }
        assert!(
            !CORE_DLLS.contains(&"msvcp140_1.dll"),
            "only onnxruntime needs msvcp140_1; treating it as core would block \
             STT and translation over a diarization-only dependency"
        );
    }

    /// A path with an apostrophe would otherwise end the PowerShell literal and
    /// turn the rest of the path into commands.
    #[test]
    fn elevate_script_escapes_apostrophes_in_the_path() {
        let script = elevate_script(r"C:\Users\O'Brien\VC_redist.x64.exe");
        assert!(
            script.contains(r"C:\Users\O''Brien\VC_redist.x64.exe"),
            "apostrophe must be doubled, got: {script}"
        );
    }

    /// Declining the prompt has to arrive as a distinct code; without the catch
    /// it would surface as a generic PowerShell failure and read as "install
    /// broken" rather than "you said no".
    #[test]
    fn elevate_script_maps_a_declined_prompt_to_error_cancelled() {
        let script = elevate_script(r"C:\vc.exe");
        assert!(script.contains("-Verb RunAs"), "elevation verb missing");
        assert!(
            script.contains(&format!("catch {{ exit {} }}", ERROR_CANCELLED)),
            "declined prompt must normalise to {}, got: {script}",
            ERROR_CANCELLED
        );
    }

    /// An attempt is written before it runs, so an interrupted one is
    /// recognisable by its missing outcome.
    #[test]
    fn a_started_attempt_has_no_outcome_yet() {
        let attempt = Attempt::starting(Stage::Download);
        assert_eq!(attempt.stage, Stage::Download);
        assert!(
            attempt.outcome.is_none(),
            "a fresh attempt must be distinguishable from a finished one"
        );
    }

    /// The record crosses a process boundary, so the shape has to survive a
    /// round-trip -- including the None that means "interrupted".
    #[test]
    fn an_interrupted_attempt_round_trips_through_json() {
        let attempt = Attempt {
            bytes_downloaded: 12_582_912,
            bytes_total: 25_635_768,
            ..Attempt::starting(Stage::Consent)
        };

        let json = serde_json::to_string(&attempt).unwrap();
        assert!(json.contains(r#""stage":"consent""#), "{json}");
        assert!(json.contains(r#""outcome":null"#), "{json}");

        let back: Attempt = serde_json::from_str(&json).unwrap();
        assert_eq!(back.stage, Stage::Consent);
        assert!(back.outcome.is_none());
        assert_eq!(back.bytes_downloaded, 12_582_912);
    }

    #[test]
    fn outcomes_serialise_in_snake_case_for_the_frontend() {
        assert_eq!(serde_json::to_string(&Outcome::Declined).unwrap(), r#""declined""#);
        assert_eq!(
            serde_json::to_string(&Outcome::RebootRequired).unwrap(),
            r#""reboot_required""#
        );
    }
}
