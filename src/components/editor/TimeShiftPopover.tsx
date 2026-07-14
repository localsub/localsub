import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type TimeShiftScope = "all" | "selection"

interface TimeShiftPopoverProps {
  disabled?: boolean
  hasSelection: boolean
  onApply: (deltaSeconds: number, scope: TimeShiftScope) => void
}

export function TimeShiftPopover({ disabled, hasSelection, onApply }: TimeShiftPopoverProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const [scope, setScope] = useState<TimeShiftScope>("all")

  const delta = Number.parseFloat(value)
  const effectiveScope: TimeShiftScope = hasSelection ? scope : "all"
  const canApply = Number.isFinite(delta) && delta !== 0

  const handleApply = () => {
    if (!canApply) return
    onApply(delta, effectiveScope)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={open ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              disabled={disabled}
            >
              <Clock className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent><p>{t("editor.timeShift.button")}</p></TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-60 p-3">
        <div className="space-y-3">
          <p className="text-sm font-medium">{t("editor.timeShift.title")}</p>
          <div className="space-y-1.5">
            <label htmlFor="time-shift-seconds" className="text-xs text-muted-foreground">
              {t("editor.timeShift.seconds")}
            </label>
            <Input
              id="time-shift-seconds"
              type="number"
              step={0.1}
              value={value}
              placeholder="0.0"
              autoFocus
              className="h-8 text-sm"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleApply() }}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={effectiveScope === "all" ? "secondary" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setScope("all")}
            >
              {t("editor.timeShift.scopeAll")}
            </Button>
            <Button
              variant={effectiveScope === "selection" ? "secondary" : "outline"}
              size="sm"
              className="h-7 text-xs"
              disabled={!hasSelection}
              onClick={() => setScope("selection")}
            >
              {t("editor.timeShift.scopeSelection")}
            </Button>
          </div>
          <Button size="sm" className="h-7 w-full text-xs" disabled={!canApply} onClick={handleApply}>
            {t("editor.timeShift.apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
