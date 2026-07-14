import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import type { JobStatus, JobStage } from "@/types"

const STATUS_STYLES: Record<JobStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  processing: "bg-status-info/15 text-status-info border-status-info/25",
  completed: "bg-status-success/15 text-status-success border-status-success/25",
  failed: "bg-status-error/15 text-status-error border-status-error/25",
  interrupted: "bg-status-warning/15 text-status-warning border-status-warning/25",
}

export function JobStatusBadge({ status, stage }: { status: JobStatus; stage: JobStage }) {
  const { t } = useTranslation()

  const statusLabel = t(`dashboard.status.${status}`, status)
  const stageLabel = status === "processing" ? t(`dashboard.stage.${stage}`, stage) : undefined

  return (
    <Badge variant="outline" className={`${STATUS_STYLES[status]} text-xs font-medium`}>
      {status === "processing" && (
        <span className="relative mr-1.5 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-info opacity-50" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-status-info" />
        </span>
      )}
      {statusLabel}
      {stageLabel && <span className="ml-1 opacity-70">({stageLabel})</span>}
    </Badge>
  )
}
