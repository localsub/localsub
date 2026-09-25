//! Which NVIDIA GPU the inference server runs on.
//!
//! LocalSub pins the server to ONE GPU — the one with the most memory — by
//! starting it with `CUDA_VISIBLE_DEVICES=<uuid>`. Left alone, Whisper takes
//! CUDA device 0 while llama.cpp spreads its layers over every visible GPU,
//! and nvidia-smi lists GPUs in PCI order where CUDA defaults to fastest
//! first, so "the first line" need not be the card doing the work. A UUID
//! names the same GPU for CUDA and for nvidia-smi, whatever the ordering.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NvidiaGpu {
    pub index: u32,
    pub uuid: String,
    pub memory_total_mb: u64,
    pub name: String,
}

/// The listing `parse_gpu_list` reads. `name` comes last so that a comma in
/// it cannot shift the other fields.
const LIST_QUERY: [&str; 2] = [
    "--query-gpu=index,uuid,memory.total,name",
    "--format=csv,noheader,nounits",
];

/// One GPU per line; a line that does not parse (a `[N/A]` field) is skipped
/// rather than failing the whole listing.
pub fn parse_gpu_list(out: &str) -> Vec<NvidiaGpu> {
    out.lines()
        .filter_map(|line| {
            let mut f = line.splitn(4, ',').map(str::trim);
            let gpu = NvidiaGpu {
                index: f.next()?.parse().ok()?,
                uuid: f.next()?.to_string(),
                memory_total_mb: f.next()?.parse().ok()?,
                name: f.next()?.to_string(),
            };
            gpu.uuid.starts_with("GPU-").then_some(gpu)
        })
        .collect()
}

/// The GPU the server is pinned to: the most memory, the lowest index among
/// equals.
pub fn pick(gpus: &[NvidiaGpu]) -> Option<&NvidiaGpu> {
    gpus.iter().max_by(|a, b| {
        a.memory_total_mb
            .cmp(&b.memory_total_mb)
            .then(b.index.cmp(&a.index))
    })
}

/// nvidia-smi can hang on a wedged driver, and the server spawn now asks it
/// which GPU to use — a hang there would keep the server from ever starting.
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_secs(5);

/// stdout of `cmd`, or None if it cannot start, fails, or outlives `timeout`
/// (it is killed then). Meant for commands with a few lines of output.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            _ => return None,
        }
    }
}

fn nvidia_smi(args: &[&str]) -> Option<String> {
    let mut cmd = crate::utils::hidden_command("nvidia-smi");
    cmd.args(args);
    run_with_timeout(cmd, NVIDIA_SMI_TIMEOUT)
}

pub fn list() -> Vec<NvidiaGpu> {
    nvidia_smi(&LIST_QUERY).map(|out| parse_gpu_list(&out)).unwrap_or_default()
}

pub fn selected() -> Option<NvidiaGpu> {
    pick(&list()).cloned()
}

/// Environment that confines a CUDA process to `gpu`. `LOCALSUB_GPU_UUID`
/// tells the Python server which card to report in /runtime/resources:
/// nvidia-smi ignores CUDA_VISIBLE_DEVICES and would list them all.
pub fn pinning_env(gpu: Option<&NvidiaGpu>) -> Vec<(String, String)> {
    match gpu {
        Some(g) => vec![
            ("CUDA_VISIBLE_DEVICES".to_string(), g.uuid.clone()),
            ("LOCALSUB_GPU_UUID".to_string(), g.uuid.clone()),
        ],
        None => Vec::new(),
    }
}

/// The number in a one-GPU `--format=csv,noheader,nounits` answer.
pub fn parse_mb(out: &str) -> Option<u64> {
    out.lines().next()?.trim().parse().ok()
}

/// Memory in use on one GPU, in MB.
pub fn memory_used_mb(uuid: &str) -> Option<u64> {
    let id = format!("--id={}", uuid);
    parse_mb(&nvidia_smi(&[&id, "--query-gpu=memory.used", "--format=csv,noheader,nounits"])?)
}

/// Readings closer than this count as "not moving".
pub const SETTLE_EPSILON_MB: u64 = 64;
/// A drop at least this large means the killed server's memory came back.
pub const RELEASED_MIN_MB: u64 = 256;
/// With no drop by now, there was nothing to free (e.g. a CPU-only run).
pub const NOTHING_HELD_AFTER: Duration = Duration::from_secs(2);

/// Whether the VRAM of a server killed while the pinned GPU used `before_mb`
/// is back, judging by two consecutive readings `prev_mb` then `now_mb`.
///
/// Relative on purpose: an absolute "free > 6000 MB" could never be met on a
/// 6 GB card, so every restart there waited out the whole timeout.
pub fn vram_settled(before_mb: u64, prev_mb: u64, now_mb: u64, waited: Duration) -> bool {
    let steady = prev_mb.abs_diff(now_mb) <= SETTLE_EPSILON_MB;
    let released = now_mb + RELEASED_MIN_MB <= before_mb;
    steady && (released || waited >= NOTHING_HELD_AFTER)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_GPUS: &str = "0, GPU-11111111-aaaa-bbbb-cccc-000000000000, 8192, NVIDIA GeForce RTX 3060 Ti\n\
                            1, GPU-22222222-aaaa-bbbb-cccc-000000000000, 24576, NVIDIA GeForce RTX 4090\n";

    #[test]
    fn lists_every_gpu_nvidia_smi_reports() {
        let gpus = parse_gpu_list(TWO_GPUS);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[1].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(gpus[1].memory_total_mb, 24576);
    }

    #[test]
    fn a_line_with_unavailable_fields_is_skipped_not_fatal() {
        let out = "0, GPU-aaaa, [N/A], Some GPU\n1, GPU-bbbb, 12288, NVIDIA GeForce RTX 3060\n";
        let gpus = parse_gpu_list(out);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].uuid, "GPU-bbbb");
    }

    #[test]
    fn a_name_with_a_comma_keeps_the_other_fields_intact() {
        let gpus = parse_gpu_list("0, GPU-aaaa, 16384, Quadro RTX 5000, Max-Q\n");
        assert_eq!(gpus[0].memory_total_mb, 16384);
        assert_eq!(gpus[0].name, "Quadro RTX 5000, Max-Q");
    }

    #[test]
    fn pins_the_gpu_with_the_most_memory_not_the_first_listed() {
        let gpus = parse_gpu_list(TWO_GPUS);
        assert_eq!(pick(&gpus).unwrap().index, 1);
    }

    #[test]
    fn among_equal_gpus_the_lowest_index_wins() {
        let gpus = parse_gpu_list("0, GPU-a, 12288, A\n1, GPU-b, 12288, B\n");
        assert_eq!(pick(&gpus).unwrap().index, 0);
    }

    #[test]
    fn no_gpu_means_no_pinning() {
        assert!(pick(&[]).is_none());
        assert!(pinning_env(None).is_empty());
    }

    #[test]
    fn pinning_names_the_gpu_by_uuid() {
        let gpus = parse_gpu_list(TWO_GPUS);
        let env = pinning_env(pick(&gpus));
        assert!(env.contains(&(
            "CUDA_VISIBLE_DEVICES".to_string(),
            "GPU-22222222-aaaa-bbbb-cccc-000000000000".to_string()
        )));
    }

    #[test]
    fn settled_once_usage_dropped_and_stopped_moving() {
        // 6 GB card: 5.8 GB in use by the old server + desktop, then freed.
        assert!(vram_settled(5800, 700, 690, Duration::from_millis(1000)));
    }

    #[test]
    fn not_settled_while_the_driver_is_still_freeing() {
        assert!(!vram_settled(5800, 3000, 700, Duration::from_millis(1000)));
    }

    #[test]
    fn not_settled_before_anything_was_released() {
        assert!(!vram_settled(5800, 5790, 5795, Duration::from_millis(1000)));
    }

    fn command(windows: &[&str], unix: &[&str]) -> Command {
        let argv = if cfg!(target_os = "windows") { windows } else { unix };
        let mut cmd = Command::new(argv[0]);
        cmd.args(&argv[1..]);
        cmd
    }

    #[test]
    fn a_hung_nvidia_smi_is_killed_at_the_timeout() {
        let t0 = Instant::now();
        let out = run_with_timeout(
            command(&["ping", "-n", "30", "127.0.0.1"], &["sleep", "30"]),
            Duration::from_millis(500),
        );
        assert!(out.is_none());
        assert!(t0.elapsed() < Duration::from_secs(5), "waited {:?}", t0.elapsed());
    }

    #[test]
    fn a_quick_command_returns_its_output() {
        let out = run_with_timeout(
            command(&["cmd", "/C", "echo 0, GPU-a, 8192, X"], &["echo", "0, GPU-a, 8192, X"]),
            Duration::from_secs(5),
        );
        assert_eq!(parse_gpu_list(&out.unwrap()).len(), 1);
    }

    #[test]
    fn settled_when_there_was_nothing_to_release() {
        // A CPU-only run: usage never moves, so after a short grace it is done.
        assert!(vram_settled(500, 500, 505, Duration::from_millis(2500)));
    }
}
