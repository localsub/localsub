use std::fs::{File, OpenOptions};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tauri::AppHandle;

use crate::error::AppError;
use crate::setup_manager;

/// Cap for the captured stderr before it rolls aside, keeping one `.1` backup.
const PYTHON_STDERR_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Opens the file the Python child's stderr is redirected into.
///
/// Rolls the previous contents aside first: the server is respawned on every
/// translation to reclaim VRAM, so an append-only capture would grow forever.
/// Returns None when the file cannot be opened — losing the capture must never
/// stop the server from starting.
fn open_stderr_capture(path: &Path, max_bytes: u64) -> Option<File> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    crate::utils::rotate_log_if_large(path, max_bytes);
    OpenOptions::new().create(true).append(true).open(path).ok()
}

pub fn spawn_python_server(app: &AppHandle, _port: u16) -> Result<Child, AppError> {
    // Make sure this install's bundled python312._pth points at the pip-env dir.
    // Required on every launch: a new-path install skips setup (global marker)
    // yet must still patch its own ._pth, else package imports fail. Idempotent.
    setup_manager::ensure_pth_patched(app)?;

    let python = setup_manager::get_python_executable(app)?;
    let server_dir = setup_manager::get_python_server_dir(app)?;
    let env_vars = setup_manager::build_python_env(app)?;

    let mut cmd = Command::new(&python);

    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = src-tauri/, go up one level to project root
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest_dir.parent().expect("Failed to get project root");
        let python_server_dir = project_root.join("python-server");
        cmd.arg("main.py").current_dir(&python_server_dir);
    } else {
        let main_py = server_dir.join("main.py");
        cmd.arg(&main_py);
    }

    for (k, v) in &env_vars {
        cmd.env(k, v);
    }
    // One GPU for the whole server — see gpu.rs.
    let gpu = crate::gpu::selected();
    if let Some(g) = &gpu {
        log::info!("Pinning the Python server to GPU {} ({}, {} MB, {})", g.index, g.name, g.memory_total_mb, g.uuid);
    }
    for (k, v) in crate::gpu::pinning_env(gpu.as_ref()) {
        cmd.env(k, v);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Capture the child's stderr. Without this it goes nowhere: the process is
    // spawned with CREATE_NO_WINDOW and no redirection, and Python writes an
    // uncaught exception's traceback to stderr rather than through `logging`.
    // A server that dies during module import therefore left `server.log`
    // ending at "Server starting" and no record at all of what killed it.
    let stderr_path = crate::utils::log_dir().join("python-stderr.log");
    if let Some(f) = open_stderr_capture(&stderr_path, PYTHON_STDERR_MAX_BYTES) {
        cmd.stderr(Stdio::from(f));
    }
    // Uvicorn's access log goes to stdout and would bury the traceback under one
    // line per 3-second health poll. What we need to keep is on stderr.
    cmd.stdout(Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        AppError::PythonServer(format!("Failed to spawn Python process: {}", e))
    })?;

    Ok(child)
}

pub async fn check_health(port: u16) -> Result<bool, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let url = format!("http://127.0.0.1:{}/health", port);
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(true),
        _ => Ok(false),
    }
}

pub async fn wait_for_healthy(port: u16) -> Result<(), AppError> {
    let max_attempts = 60; // 30 seconds at 500ms intervals
    for _ in 0..max_attempts {
        if check_health(port).await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(AppError::PythonServer(
        "Python server failed to start within 30 seconds".to_string(),
    ))
}

/// Put a freshly spawned server into `slot`, killing whatever was there first.
///
/// Overwriting the handle instead orphaned the old process: after a crash is
/// declared the old server may only be hung, still holding port 9111 and its
/// VRAM, and nothing tracked it any more — not even the app's exit handler,
/// which only kills the handle it still has.
pub fn replace_server_process(slot: &mut Option<Child>, child: Child) {
    if let Some(mut old) = slot.take() {
        let _ = kill_server(&mut old);
    }
    #[cfg(target_os = "windows")]
    server_job::adopt(&child);
    *slot = Some(child);
}

/// The Windows job that owns every Python server this app starts.
///
/// Windows does not end a child when its parent dies, so an app that crashed —
/// or was ended from Task Manager — left its server running, holding port 9111
/// and VRAM into the next launch. The job is created with KILL_ON_JOB_CLOSE and
/// never closed by us: when the app process goes away, however it goes, Windows
/// closes the handle and terminates everything still in the job.
#[cfg(target_os = "windows")]
pub(crate) mod server_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    type Handle = *mut c_void;

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION and its members, laid out as in
    // winnt.h. SetInformationJobObject rejects the call if the size is wrong.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(crate) struct Job(Handle);

    // A job handle is a kernel handle: usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub(crate) fn kill_on_close() -> std::io::Result<Job> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job(handle);
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }

        pub(crate) fn assign(&self, child: &Child) -> std::io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as Handle) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// Lives for the whole process and is never dropped: its handle closes
    /// only when the app itself goes away.
    static SERVER_JOB: OnceLock<Option<Job>> = OnceLock::new();

    /// Tie `child` to the app's lifetime. Best effort: if the job cannot be
    /// made or joined, the server still runs, just without this guarantee.
    pub(crate) fn adopt(child: &Child) {
        let job = SERVER_JOB.get_or_init(|| match Job::kill_on_close() {
            Ok(job) => Some(job),
            Err(e) => {
                log::warn!("Could not create the server job object: {}", e);
                None
            }
        });
        if let Some(job) = job {
            if let Err(e) = job.assign(child) {
                log::warn!("Could not put the Python server (pid {}) in the job: {}", child.id(), e);
            }
        }
    }
}

pub fn kill_server(child: &mut Child) -> Result<(), AppError> {
    kill_process_tree(child)?;
    let _ = child.wait();
    Ok(())
}

/// Kill the process and all its descendants.
/// On Windows, `child.kill()` only kills the direct process — Uvicorn workers
/// survive and keep the port open. We use `taskkill /T /F` to kill the entire
/// process tree.
#[cfg(target_os = "windows")]
fn kill_process_tree(child: &mut Child) -> Result<(), AppError> {
    let pid = child.id();
    let output = crate::utils::hidden_command("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| {
            AppError::PythonServer(format!("Failed to run taskkill: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("taskkill stderr (pid {}): {}", pid, stderr);
        // Fallback to regular kill
        let _ = child.kill();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn kill_process_tree(child: &mut Child) -> Result<(), AppError> {
    // On Unix, send SIGKILL to the process group
    child.kill().map_err(|e| {
        AppError::PythonServer(format!("Failed to kill Python process: {}", e))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use sysinfo::{Pid, ProcessesToUpdate, System};

    /// A child that would run for 30 s unless something kills it.
    fn sleeper() -> Child {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn().expect("spawn sleeper")
    }

    fn is_alive(pid: u32) -> bool {
        let pid = Pid::from_u32(pid);
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        sys.process(pid).is_some()
    }

    fn exits_within(child: &mut Child, limit: Duration) -> bool {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < limit {
            if let Ok(Some(_)) = child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// After a crash is declared the old server may only be hung — still
    /// holding port 9111 and its VRAM. Overwriting its handle orphaned it:
    /// nothing tracked it any more, not even the app's exit handler.
    #[test]
    fn replacing_the_server_process_kills_the_old_one() {
        let old = sleeper();
        let old_pid = old.id();
        let mut slot = Some(old);

        replace_server_process(&mut slot, sleeper());

        assert!(!is_alive(old_pid), "the replaced server process is still running");
        let _ = kill_server(slot.as_mut().unwrap());
    }

    /// Windows does not end a child when its parent dies. The job is what
    /// takes the server down with the app — including when the app crashes and
    /// never runs its exit handler: closing the job handle is what the OS does
    /// to a dead process's handles.
    #[cfg(target_os = "windows")]
    #[test]
    fn closing_the_server_job_kills_the_processes_in_it() {
        let mut child = sleeper();
        let job = server_job::Job::kill_on_close().expect("create job");
        job.assign(&child).expect("assign child");

        drop(job);

        let died = exits_within(&mut child, Duration::from_secs(5));
        if !died {
            let _ = kill_server(&mut child);
        }
        assert!(died, "a process in a closed kill-on-close job must be terminated");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("localsub_python_manager_test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("log.1"));
        p
    }

    /// The whole point of the capture file: a crashing child must leave its
    /// traceback behind. Python writes uncaught tracebacks to stderr, not
    /// through `logging`, so nothing reaches `server.log` — the fresh-PC
    /// failure showed `server.log` ending at "Server starting" with no cause.
    #[test]
    fn stderr_capture_opens_an_appendable_file() {
        let p = scratch("capture.log");

        let mut f = open_stderr_capture(&p, 1024).expect("capture file must open");
        use std::io::Write;
        f.write_all(b"Traceback (most recent call last):\n").unwrap();
        drop(f);

        assert!(fs::read_to_string(&p).unwrap().contains("Traceback"));
    }

    /// The server respawns on every translation (VRAM reclaim), so an
    /// append-only capture would grow without bound.
    #[test]
    fn stderr_capture_rolls_the_file_aside_once_it_is_too_big() {
        let p = scratch("big.log");
        fs::write(&p, vec![b'x'; 4096]).unwrap();

        let f = open_stderr_capture(&p, 1024).expect("capture file must open");
        drop(f);

        assert_eq!(fs::metadata(&p).unwrap().len(), 0, "capture should restart empty");
        assert!(p.with_extension("log.1").exists(), "previous run must be kept as .1");
    }
}
