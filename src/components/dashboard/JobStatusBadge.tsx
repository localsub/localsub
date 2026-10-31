import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import type { JobStatus, JobStage } from "@/types"

const STATUS_STYLES: Record<JobStatus, string> = {
  pending: "bg-muted text-foreground-secondary",
  processing: "bg-primary-soft text-primary-text",
  completed: "bg-status-success-soft text-status-success",
  failed: "bg-status-error-soft text-status-error",
  interrupted: "bg-status-warning-soft text-status-warning",
}

export function JobStatusBadge({ status, stage }: { status: JobStatus; stage: JobStage }) {
  const { t } = useTranslation()

  const statusLabel = t(`dashboard.status.${status}`, status)
  const stageLabel = status === "processing" ? t(`dashboard.stage.${stage}`, stage) : undefined

  return (
    <Badge
      className={`${STATUS_STYLES[status]} max-w-full gap-1.5`}
      title={stageLabel ? `${statusLabel} (${stageLabel})` : undefined}
    >
      {status === "processing" && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      )}
      <span className="shrink-0">{statusLabel}</span>
      {/* Long stage names (e.g. "Translating") give way inside the fixed status column */}
      {stageLabel && <span className="min-w-0 truncate font-semibold opacity-75">({stageLabel})</span>}
    </Badge>
  )
}
