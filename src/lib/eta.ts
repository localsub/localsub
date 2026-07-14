// ETA estimation for long-running per-segment pipelines (translation).
// Estimates remaining time from the mean interval of recent segment timestamps.

/** Max number of recent timestamps considered (= 19 intervals). */
export const ETA_WINDOW = 20

/**
 * Estimate remaining time in ms from segment-completion timestamps.
 *
 * Uses the mean interval of the most recent `WINDOW` timestamps so the
 * estimate adapts to current throughput instead of being dragged by a
 * slow warm-up (model load, prompt cache build).
 *
 * @param timestamps monotonically increasing timestamps (ms), e.g. performance.now()
 * @param remainingCount segments left to process
 * @returns estimated ms remaining, or null with fewer than 2 interval samples
 */
export function estimateRemaining(timestamps: number[], remainingCount: number): number | null {
  const recent = timestamps.slice(-ETA_WINDOW)
  if (recent.length < 3) return null
  const meanInterval = (recent[recent.length - 1] - recent[0]) / (recent.length - 1)
  return Math.round(meanInterval * remainingCount)
}

export interface EtaLabel {
  key: string
  count?: number
  minutes?: number
}

/**
 * Map an ETA in ms to an i18n key + interpolation values.
 * - < 1 min  → dashboard.eta.lessThanMinute
 * - < 1 hour → dashboard.eta.minutes (count = minutes, rounded up)
 * - ≥ 1 hour → dashboard.eta.hoursMinutes (count = hours, minutes = remainder)
 */
export function formatEta(ms: number): EtaLabel {
  if (ms < 60_000) return { key: "dashboard.eta.lessThanMinute" }
  if (ms < 3_600_000) return { key: "dashboard.eta.minutes", count: Math.ceil(ms / 60_000) }
  let hours = Math.floor(ms / 3_600_000)
  let minutes = Math.round((ms % 3_600_000) / 60_000)
  if (minutes === 60) {
    hours += 1
    minutes = 0
  }
  return { key: "dashboard.eta.hoursMinutes", count: hours, minutes }
}
