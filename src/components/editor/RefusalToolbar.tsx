import { useTranslation } from "react-i18next"
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react"
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
      <div className="flex items-center gap-1.5">
        <Toggle
          size="sm"
          pressed={filterActive}
          onPressedChange={onFilterChange}
          disabled={count === 0}
          className="h-7 min-w-0 gap-1.5 px-2 text-xs font-medium text-amber-600 dark:text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-500 data-[state=on]:bg-amber-500/10 data-[state=on]:text-amber-600 dark:data-[state=on]:text-amber-500 [&_svg]:size-3.5"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("editor.refusal.filterToggle")}
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] tabular-nums leading-4">
            {count}
          </span>
        </Toggle>
        {progress ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("editor.refusal.progress", { done: progress.done, total: progress.total })}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCancel}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("editor.refusal.cancel")}</p></TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={retranslateDisabled || count === 0}
            onClick={onRetranslateAll}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("editor.refusal.retranslateAll", { count })}
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}
