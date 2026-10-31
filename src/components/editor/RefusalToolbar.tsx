import { useTranslation } from "react-i18next"
import { AlertTriangle, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export interface RefusalBatchProgress {
  done: number
  total: number
}

interface RefusalToolbarProps {
  /** Number of currently flagged lines */
  count: number
  filterActive: boolean
  onFilterChange: (on: boolean) => void
  onRetranslateAll: () => void
  /** Disables batch retranslate (liveMode, single retranslate in flight, …) */
  retranslateDisabled: boolean
  /** Non-null while a batch run is in progress */
  progress: RefusalBatchProgress | null
  onCancel: () => void
}

export function RefusalToolbar({
  count,
  filterActive,
  onFilterChange,
  onRetranslateAll,
  retranslateDisabled,
  progress,
  onCancel,
}: RefusalToolbarProps) {
  const { t } = useTranslation()

  if (count === 0 && !progress) return null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-2">
        {/* Soft amber at rest; pressed (filtering) goes solid so the state reads at a glance */}
        <Toggle
          pressed={filterActive}
          onPressedChange={onFilterChange}
          disabled={count === 0}
          className="group h-[38px] min-w-0 gap-[7px] rounded-[11px] bg-status-warning-soft px-3 text-sm font-bold text-status-warning hover:bg-status-warning-soft hover:text-status-warning data-[state=on]:bg-status-warning data-[state=on]:text-white [&_svg]:size-4"
        >
          <AlertTriangle />
          {t("editor.refusal.filterToggle")}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-status-warning px-1.5 text-[11.5px] tabular-nums text-white group-data-[state=on]:bg-white group-data-[state=on]:text-status-warning">
            {count}
          </span>
        </Toggle>
        {progress ? (
          <div className="flex h-[38px] items-center gap-2.5 rounded-[11px] bg-primary-soft pl-3 pr-1.5 text-sm font-bold text-primary-text">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="tabular-nums">
              {t("editor.refusal.progress", { done: progress.done, total: progress.total })}
            </span>
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-card">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-[8px] bg-card text-foreground-secondary hover:bg-card hover:text-foreground [&_svg]:size-3.5"
                  onClick={onCancel}
                  aria-label={t("editor.refusal.cancel")}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("editor.refusal.cancel")}</p></TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-[38px] bg-card px-3 text-foreground-secondary shadow-card hover:bg-card hover:text-foreground"
            disabled={retranslateDisabled || count === 0}
            onClick={onRetranslateAll}
          >
            {t("editor.refusal.retranslateAll", { count })}
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}
