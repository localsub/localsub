import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

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
              variant="ghost"
              size="icon"
              className={cn(open && "bg-muted text-foreground")}
              disabled={disabled}
              aria-label={t("editor.timeShift.button")}
            >
              <Clock />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent><p>{t("editor.timeShift.button")}</p></TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[280px] rounded-[20px] p-5">
        <div className="flex flex-col gap-3.5">
          <p className="text-base font-extrabold">{t("editor.timeShift.title")}</p>
          <div className="flex flex-col gap-[7px]">
            <label htmlFor="time-shift-seconds" className="text-[13px] font-semibold text-muted-foreground">
              {t("editor.timeShift.seconds")}
            </label>
            <Input
              id="time-shift-seconds"
              type="number"
              step={0.1}
              value={value}
              placeholder="0.0"
              autoFocus
              className="h-[46px] px-3.5 text-base font-bold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleApply() }}
            />
          </div>
          <div role="radiogroup" className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-1">
            {(["all", "selection"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={effectiveScope === s}
                disabled={s === "selection" && !hasSelection}
                onClick={() => setScope(s)}
                className={cn(
                  "h-9 rounded-[9px] text-[13.5px] outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                  effectiveScope === s
                    ? "bg-card font-bold text-foreground shadow-segment"
                    : "font-semibold text-muted-foreground enabled:hover:text-foreground",
                )}
              >
                {s === "all" ? t("editor.timeShift.scopeAll") : t("editor.timeShift.scopeSelection")}
              </button>
            ))}
          </div>
          <Button className="h-[46px] w-full" disabled={!canApply} onClick={handleApply}>
            {t("editor.timeShift.apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
