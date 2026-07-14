import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { X, ChevronUp, ChevronDown, ALargeSmall, Languages, Replace, ReplaceAll } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

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
    <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
      <TooltipProvider delayDuration={300}>
        {/* Find input */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => onFindQueryChange(e.target.value)}
            placeholder={t("editor.findReplace.placeholder")}
            className="h-7 text-sm flex-1 min-w-[120px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.shiftKey ? onPrevMatch() : onNextMatch()
              }
              if (e.key === "Escape") onClose()
            }}
          />

          {findQuery && (
            <Badge variant="secondary" className="text-[10px] h-5 shrink-0 tabular-nums">
              {matchCount > 0 ? `${matchIndex + 1} / ${matchCount}` : "0 / 0"}
            </Badge>
          )}

          {/* Prev / Next */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onPrevMatch} disabled={matchCount === 0}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Previous</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onNextMatch} disabled={matchCount === 0}>
                <ChevronDown className="h-3.5 w-3.5" />
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
                className="h-7 w-7 p-0 shrink-0"
              >
                <ALargeSmall className="h-3.5 w-3.5" />
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
                className="h-7 w-7 p-0 shrink-0"
              >
                <Languages className="h-3.5 w-3.5" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.searchOriginal")}</p></TooltipContent>
          </Tooltip>
        </div>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Replace input */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Input
            value={replaceQuery}
            onChange={(e) => onReplaceQueryChange(e.target.value)}
            placeholder={t("editor.findReplace.replacePlaceholder")}
            className="h-7 text-sm flex-1 min-w-[120px]"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose()
            }}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0" onClick={onReplace} disabled={matchCount === 0}>
                <Replace className="h-3.5 w-3.5 mr-1" />
                {t("editor.findReplace.replace")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.replace")}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0" onClick={onReplaceAll} disabled={matchCount === 0}>
                <ReplaceAll className="h-3.5 w-3.5 mr-1" />
                {t("editor.findReplace.replaceAll")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{t("editor.findReplace.replaceAll")}</p></TooltipContent>
          </Tooltip>
        </div>

        {/* Close */}
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </TooltipProvider>
    </div>
  )
}
