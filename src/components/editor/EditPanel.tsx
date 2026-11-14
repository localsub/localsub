import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { AddToVocabForm } from "./AddToVocabDialog"
import { cn } from "@/lib/utils"
import type { SubtitleLine, Vocabulary } from "@/types"

interface EditPanelProps {
  line: SubtitleLine | null
  onUpdateLine: (id: string, updates: Partial<SubtitleLine>) => void
  onSplit: (id: string) => void
  onMergeWithNext: (id: string) => void
  onDelete?: (id: string) => void
  onRetranslate?: (id: string) => void
  canSplitLine: boolean
  canMergeLine: boolean
  retranslating?: boolean
  vocabularies?: Vocabulary[]
  onUpdateVocabulary?: (v: Vocabulary) => Promise<Vocabulary[]>
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`
}

function parseTimestamp(input: string): number | null {
  // Support formats: m:ss.mmm, m:ss, mm:ss.mmm, mm:ss
  const match = input.trim().match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/)
  if (!match) return null
  const m = parseInt(match[1], 10)
  const s = parseInt(match[2], 10)
  const ms = match[3] ? parseInt(match[3].padEnd(3, "0"), 10) : 0
  if (s >= 60) return null
  return m * 60 + s + ms / 1000
}

function TimestampInput({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (seconds: number) => void
  label: string
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")

  useEffect(() => {
    if (!editing) setText(formatTimestamp(value))
  }, [value, editing])

  const handleBlur = useCallback(() => {
    setEditing(false)
    const parsed = parseTimestamp(text)
    if (parsed !== null && parsed >= 0) {
      onChange(parsed)
    } else {
      setText(formatTimestamp(value))
    }
  }, [text, value, onChange])

  // The whole box is the field: label left, value right, focus ring on the box
  return (
    <label className="flex h-11 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md bg-muted px-3.5 transition-[background-color,box-shadow] duration-150 focus-within:bg-card focus-within:shadow-[inset_0_0_0_2px_hsl(var(--primary))]">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <input
        value={text}
        onChange={(e) => { setEditing(true); setText(e.target.value) }}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === "Enter") handleBlur() }}
        className="min-w-0 flex-1 bg-transparent text-right text-[15px] font-semibold tabular-nums outline-none"
      />
    </label>
  )
}

// Labels must fit at any panel width (the panel resizes down to 25%) and in
// every language: two columns, and a label that is still too long wraps
// inside the button instead of running out of it.
const actionClass =
  "h-auto min-h-[42px] min-w-0 whitespace-normal rounded-md px-2 py-1.5 text-center text-sm leading-tight [&_svg]:size-4"

export function EditPanel({ line, onUpdateLine, onSplit, onMergeWithNext, onDelete, onRetranslate, canSplitLine, canMergeLine, retranslating, vocabularies, onUpdateVocabulary }: EditPanelProps) {
  const { t } = useTranslation()
  const [vocabOpen, setVocabOpen] = useState(false)

  if (!line) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-center">
        <p className="text-[15px] text-muted-foreground">
          {t("editor.selectToEdit")}
        </p>
      </div>
    )
  }

  const duration = line.end_time - line.start_time
  const charCount = line.original_text.length
  const cps = duration > 0 ? Math.round(charCount / duration) : 0

  return (
    <div className="flex h-full flex-col gap-3.5 overflow-y-auto p-5">
      {/* Header: index + duration */}
      <div className="flex items-center gap-2.5">
        <span className="text-lg font-extrabold tabular-nums">#{line.index}</span>
        <span className="inline-flex h-6 items-center rounded-[7px] bg-muted px-2 text-xs font-bold tabular-nums text-foreground-secondary">
          {duration.toFixed(1)}s
        </span>
        <div className="flex-1" />
        {onDelete && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-2 h-8 px-2 text-sm font-semibold text-status-error hover:bg-status-error-soft hover:text-status-error"
                  onClick={() => onDelete(line.id)}
                >
                  {t("editor.delete")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("editor.deleteTooltip")} <kbd className="ml-1 opacity-60">Del</kbd></p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {/* Start / end */}
      <div className="flex items-center gap-2">
        <TimestampInput
          value={line.start_time}
          onChange={(v) => onUpdateLine(line.id, { start_time: v })}
          label={t("editor.startTime")}
        />
        <TimestampInput
          value={line.end_time}
          onChange={(v) => onUpdateLine(line.id, { end_time: v })}
          label={t("editor.endTime")}
        />
      </div>

      {/* Original text */}
      <div className="flex flex-col gap-2">
        <Label className="text-[13px] font-semibold text-muted-foreground">{t("editor.originalText")}</Label>
        <Textarea
          value={line.original_text}
          onChange={(e) => onUpdateLine(line.id, { original_text: e.target.value, status: "editing" })}
          rows={2}
          className="min-h-[52px] resize-none px-3.5 py-[13px] text-[15px]"
        />
      </div>

      {/* Translated text */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label className="text-[13px] font-semibold text-muted-foreground">{t("editor.translatedText")}</Label>
          <div className="flex-1" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("editor.stats.chars")} {charCount} · {t("editor.stats.cps")} {cps}
          </span>
        </div>
        <Textarea
          value={line.translated_text}
          onChange={(e) => onUpdateLine(line.id, { translated_text: e.target.value, status: "editing" })}
          rows={2}
          className="min-h-[52px] resize-none px-3.5 py-[13px] text-[15px] font-semibold"
          placeholder={t("editor.translationPlaceholder")}
        />
      </div>

      {/* Actions */}
      <TooltipProvider>
        <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" className={actionClass} disabled={!canSplitLine} onClick={() => onSplit(line.id)}>
                {t("editor.actions.split")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("editor.actions.splitTooltip")} <kbd className="ml-1 opacity-60">Ctrl+Shift+S</kbd></p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" className={actionClass} disabled={!canMergeLine} onClick={() => onMergeWithNext(line.id)}>
                {t("editor.actions.mergeNext")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("editor.actions.mergeNextTooltip")} <kbd className="ml-1 opacity-60">Ctrl+Shift+M</kbd></p>
            </TooltipContent>
          </Tooltip>
          {vocabularies && onUpdateVocabulary && (
            <Popover open={vocabOpen} onOpenChange={setVocabOpen}>
              <PopoverTrigger asChild>
                <Button variant="secondary" className={actionClass}>
                  {t("editor.vocab.addToVocab")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[340px] rounded-[20px] p-5" align="end" collisionPadding={16}>
                <div className="flex flex-col gap-4">
                  <p className="text-base font-extrabold">{t("editor.vocab.addToVocab")}</p>
                  <AddToVocabForm
                    vocabularies={vocabularies}
                    onUpdateVocabulary={onUpdateVocabulary}
                    onDone={() => setVocabOpen(false)}
                  />
                </div>
              </PopoverContent>
            </Popover>
          )}
          {onRetranslate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  className={cn(actionClass, "bg-primary-soft text-primary-text hover:bg-primary-soft/70")}
                  disabled={retranslating}
                  onClick={() => onRetranslate(line.id)}
                >
                  {retranslating && <RefreshCw className="animate-spin" />}
                  {t("editor.actions.retranslate", "Retranslate")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("editor.actions.retranslateTooltip", "Retranslate this line")}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
    </div>
  )
}
