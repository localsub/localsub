import { useState, useCallback } from "react";
import { detectHardware, recommendProfile, checkDiskSpace } from "../lib/tauriApi";
import type { HardwareInfo, ProfileRecommendation, DiskSpace } from "../types";

export function useHardware() {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [recommendation, setRecommendation] = useState<ProfileRecommendation | null>(null);
  const [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const hw = await detectHardware();
      setHardware(hw);
      const rec = await recommendProfile(hw);
      setRecommendation(rec);
      return { hardware: hw, recommendation: rec };
    } catch (e) {
      console.error("Hardware detection failed:", e);
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const checkDisk = useCallback(async (path: string) => {
    try {
      const ds = await checkDiskSpace(path);
      setDiskSpace(ds);
      return ds;
    } catch (e) {
      console.error("Disk space check failed:", e);
      return null;
    }
  }, []);

  return { hardware, recommendation, diskSpace, loading, error, detect, checkDisk };
}
