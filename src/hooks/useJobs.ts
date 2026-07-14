import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Job } from "../types";
import { getJobs } from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";

export function useJobs() {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());

  useEffect(() => {
    // Load existing jobs
    getJobs()
      .then((list) => {
        const map = new Map<string, Job>();
        for (const job of list) {
          map.set(job.id, job);
        }
        setJobs(map);
      })
      .catch((e) => {
        console.error(e);
        toastError(i18n.t("toast.jobsLoadFailed"));
      });

    // Listen for job updates
    let unlisten: (() => void) | null = null;
    listen<Job>("job-updated", (event) => {
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(event.payload.id, event.payload);
        return next;
      });
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // Return jobs sorted by id descending (newest first)
  const jobList = Array.from(jobs.values()).sort((a, b) =>
    b.id.localeCompare(a.id)
  );

  return { jobs: jobList };
}
