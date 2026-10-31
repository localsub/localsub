import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { X, ChevronUp, ChevronDown, ALargeSmall, Languages, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const iconButton = "h-10 w-10 shrink-0 rounded-[11px] p-0 [&_svg]:size-[18px]"

interface FindReplaceBarProps {
  findQuery: string
  replaceQuery: string
  caseSensitive: boolean
  searchOriginal: boolean
  matchCount: number
  matchIndex: number
  onFindQueryChange: (q: string) => void
  onReplaceQueryChange: (q: string) => void
  onCaseSensitiveChange: (v: boolean) => void
  onSearchOriginalChange: (v: boolean) => void
  onPrevMatch: () => void
  onNextMatch: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}

export function FindReplaceBar({
  findQuery,
  replaceQuery,
  caseSensitive,
  searchOriginal,
  matchCount,
  matchIndex,
  onFindQueryChange,
  onReplaceQueryChange,
  onCaseSensitiveChange,
  onSearchOriginalChange,
  onPrevMatch,
  onNextMatch,
  onReplace,
  onReplaceAll,
  onClose,
}: FindReplaceBarProps) {
  const { t } = useTranslation()
  const findInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    findInputRef.current?.focus()
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-2 rounded-[18px] bg-card p-2.5 shadow-card">
      <TooltipProvider delayDuration={300}>
        {/* Find input */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="relative min-w-[140px] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => onFindQueryChange(e.target.value)}
            placeholder={t("editor.findReplace.placeholder")}
            className={cn("h-11 pl-10 font-semibold", findQuery && "pr-20")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.shiftKey ? onPrevMatch() : onNextMatch()
              }
              if (e.key === "Escape") onClose()
            }}
          />

          {findQuery && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 inline-flex h-6 -translate-y-1/2 items-center rounded-[7px] bg-muted px-2 text-[12.5px] font-bold tabular-nums text-foreground-secondary">
              {matchCount > 0 ? `${matchIndex + 1} / ${matchCount}` : "0 / 0"}
            </span>
          )}
          </div>

          {/* Prev / Next */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className={iconButton} onClick={onPrevMatch} disabled={matchCount === 0}>
                <ChevronUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Previous</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className={iconButton} onClick={onNextMatch} disabled={matchCount === 0}>
                <ChevronDown />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Next</p></TooltipContent>
          </Tooltip>

          {/* Toggles */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={caseSensitive}
                onPressedChange={onCaseSensitiveChange}
                className={iconButton}
              >
                <ALargeSmall />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.caseSensitive")}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={searchOriginal}
                onPressedChange={onSearchOriginalChange}
                className={iconButton}
              >
                <Languages />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.searchOriginal")}</p></TooltipContent>
          </Tooltip>
        </div>

        <div className="mx-1 h-6 w-px shrink-0 bg-border" />

        {/* Replace input */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            value={replaceQuery}
            onChange={(e) => onReplaceQueryChange(e.target.value)}
            placeholder={t("editor.findReplace.replacePlaceholder")}
            className="h-11 min-w-[120px] flex-1 font-semibold"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose()
            }}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="sm" className="h-10 shrink-0 px-3.5" onClick={onReplace} disabled={matchCount === 0}>
                {t("editor.findReplace.replace")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.replace")}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="sm" className="h-10 shrink-0 px-3.5" onClick={onReplaceAll} disabled={matchCount === 0}>
                {t("editor.findReplace.replaceAll")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.replaceAll")}</p></TooltipContent>
          </Tooltip>
        </div>

        {/* Close */}
        <Button variant="ghost" size="icon" className={cn(iconButton, "text-muted-foreground")} onClick={onClose} aria-label={t("shortcuts.closeFind")}>
          <X />
        </Button>
      </TooltipProvider>
    </div>
  )
}
