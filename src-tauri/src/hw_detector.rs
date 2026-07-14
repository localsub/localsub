use sysinfo::System;

use crate::error::AppError;
use crate::state::{DiskSpace, GpuInfo, HardwareInfo};

pub fn detect_hardware() -> Result<HardwareInfo, AppError> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_name = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let cpu_cores = sys.cpus().len();

    let total_ram_gb = sys.total_memory() as f64 / 1_073_741_824.0;
    let available_ram_gb = sys.available_memory() as f64 / 1_073_741_824.0;

    let (avx_support, avx2_support) = detect_avx();

    let gpu = detect_nvidia_gpu();

    Ok(HardwareInfo {
        cpu_name,
        cpu_cores,
        avx_support,
        avx2_support,
        total_ram_gb,
        available_ram_gb,
        gpu,
    })
}

#[cfg(target_arch = "x86_64")]
fn detect_avx() -> (bool, bool) {
    let avx = is_x86_feature_detected!("avx");
    let avx2 = is_x86_feature_detected!("avx2");
    (avx, avx2)
}

#[cfg(not(target_arch = "x86_64"))]
fn detect_avx() -> (bool, bool) {
    (false, false)
}

fn detect_nvidia_gpu() -> Option<GpuInfo> {
    let output = crate::utils::hidden_command("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim().to_string();
    let parts: Vec<&str> = line.splitn(2, ',').collect();
    if parts.len() < 2 {
        return None;
    }

    let name = parts[0].trim().to_string();
    let vram_mb = parts[1].trim().parse::<u64>().ok()?;

    let cuda_version = detect_cuda_version();

    Some(GpuInfo {
        name,
        vram_mb,
        cuda_version,
    })
}

fn detect_cuda_version() -> Option<String> {
    let output = crate::utils::hidden_command("nvidia-smi")
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // nvidia-smi header contains "CUDA Version: XX.X"
    for line in stdout.lines() {
        if let Some(pos) = line.find("CUDA Version:") {
            let rest = &line[pos + 13..];
            let version = rest.trim().split_whitespace().next()?;
            return Some(version.to_string());
        }
    }
    None
}

pub fn check_disk_space(path: &str) -> Result<DiskSpace, AppError> {
    use sysinfo::Disks;

    let disks = Disks::new_with_refreshed_list();
    let target = std::path::Path::new(path);

    // Find the disk that contains this path (longest mount-point match)
    let mut best: Option<&sysinfo::Disk> = None;
    let mut best_len = 0;

    for disk in disks.list() {
        let mount = disk.mount_point();
        if target.starts_with(mount) {
            let len = mount.as_os_str().len();
            if len > best_len {
                best_len = len;
                best = Some(disk);
            }
        }
    }

    match best {
        Some(disk) => Ok(DiskSpace {
            path: path.to_string(),
            total_gb: disk.total_space() as f64 / 1_073_741_824.0,
            free_gb: disk.available_space() as f64 / 1_073_741_824.0,
        }),
        None => Err(AppError::Hardware(format!(
            "Could not determine disk space for path: {}",
            path
        ))),
    }
}

pub fn recommend_profile(hw: &HardwareInfo) -> crate::state::ProfileRecommendation {
    use crate::state::{Profile, ProfileRecommendation};

    let gpu_vram_mb = hw.gpu.as_ref().map(|g| g.vram_mb);
    let gpu_detected = hw.gpu.is_some();

    let (recommended, reason) = if hw.total_ram_gb >= 32.0 && gpu_vram_mb.unwrap_or(0) >= 8000 {
        (
            Profile::Power,
            "32GB+ RAM and 8GB+ VRAM detected — full GPU offload possible".to_string(),
        )
    } else if hw.total_ram_gb >= 16.0 && gpu_vram_mb.unwrap_or(0) >= 4000 {
        (
            Profile::Balanced,
            "16GB+ RAM and 4GB+ VRAM detected — partial GPU offload".to_string(),
        )
    } else {
        let reason = if gpu_detected {
            "Limited VRAM or RAM — CPU-only inference recommended".to_string()
        } else {
            "No GPU detected — CPU-only inference".to_string()
        };
        (Profile::Lite, reason)
    };

    ProfileRecommendation {
        recommended,
        reason,
        gpu_detected,
        gpu_vram_mb,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{HardwareInfo, Profile};

    #[test]
    fn test_detect_hardware_returns_valid() {
        let hw = detect_hardware().unwrap();
        assert!(hw.cpu_cores >= 1);
        assert!(hw.total_ram_gb > 0.0);
        assert!(!hw.cpu_name.is_empty());
    }

    #[test]
    fn test_recommend_profile_lite_no_gpu() {
        let hw = HardwareInfo {
            cpu_name: "Test CPU".into(),
            cpu_cores: 4,
            avx_support: true,
            avx2_support: true,
            total_ram_gb: 8.0,
            available_ram_gb: 4.0,
            gpu: None,
        };
        let rec = recommend_profile(&hw);
        assert_eq!(rec.recommended, Profile::Lite);
        assert!(!rec.gpu_detected);
    }

    #[test]
    fn test_recommend_profile_balanced() {
        let hw = HardwareInfo {
            cpu_name: "Test CPU".into(),
            cpu_cores: 8,
            avx_support: true,
            avx2_support: true,
            total_ram_gb: 16.0,
            available_ram_gb: 10.0,
            gpu: Some(crate::state::GpuInfo {
                name: "RTX 3060".into(),
                vram_mb: 6000,
                cuda_version: Some("12.0".into()),
            }),
        };
        let rec = recommend_profile(&hw);
        assert_eq!(rec.recommended, Profile::Balanced);
        assert!(rec.gpu_detected);
    }

    #[test]
    fn test_recommend_profile_power() {
        let hw = HardwareInfo {
            cpu_name: "Test CPU".into(),
            cpu_cores: 16,
            avx_support: true,
            avx2_support: true,
            total_ram_gb: 64.0,
            available_ram_gb: 40.0,
            gpu: Some(crate::state::GpuInfo {
                name: "RTX 4090".into(),
                vram_mb: 24000,
                cuda_version: Some("12.4".into()),
            }),
        };
        let rec = recommend_profile(&hw);
        assert_eq!(rec.recommended, Profile::Power);
        assert!(rec.gpu_detected);
        assert_eq!(rec.gpu_vram_mb, Some(24000));
    }

    #[test]
    fn test_check_disk_space_root() {
        // On Windows, check C:/ or on Linux /
        let path = if cfg!(windows) { "C:/" } else { "/" };
        let space = check_disk_space(path).unwrap();
        assert!(space.free_gb > 0.0);
        assert!(space.total_gb > 0.0);
    }
}
