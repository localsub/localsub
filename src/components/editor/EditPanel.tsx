import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Clock, Type, ArrowRight, Scissors, Merge, Trash2, BookPlus, RefreshCw } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { AddToVocabForm } from "./AddToVocabDialog"
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

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Input
        value={text}
        onChange={(e) => { setEditing(true); setText(e.target.value) }}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === "Enter") handleBlur() }}
        className="h-7 w-24 text-xs tabular-nums font-mono"
      />
    </div>
  )
}

export function EditPanel({ line, onUpdateLine, onSplit, onMergeWithNext, onDelete, onRetranslate, canSplitLine, canMergeLine, retranslating, vocabularies, onUpdateVocabulary }: EditPanelProps) {
  const { t } = useTranslation()
  const [vocabOpen, setVocabOpen] = useState(false)

  if (!line) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t("editor.selectToEdit")}
        </p>
      </div>
    )
  }

  const duration = line.end_time - line.start_time
  const charCount = line.original_text.length
  const cps = duration > 0 ? Math.round(charCount / duration) : 0

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header: index + time range */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="tabular-nums">#{line.index}</Badge>
          <TimestampInput
            value={line.start_time}
            onChange={(v) => onUpdateLine(line.id, { start_time: v })}
            label={t("editor.startTime")}
          />
          <ArrowRight className="h-3 w-3 text-muted-foreground mt-4" />
          <TimestampInput
            value={line.end_time}
            onChange={(v) => onUpdateLine(line.id, { end_time: v })}
            label={t("editor.endTime")}
          />
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {duration.toFixed(1)}s
        </Badge>
      </div>

      {/* Actions */}
      <TooltipProvider>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={!canSplitLine}
                onClick={() => onSplit(line.id)}
              >
                <Scissors className="mr-1.5 h-3.5 w-3.5" />
                {t("editor.actions.split")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("editor.actions.splitTooltip")} <kbd className="ml-1 text-[10px] opacity-60">Ctrl+Shift+S</kbd></p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={!canMergeLine}
                onClick={() => onMergeWithNext(line.id)}
              >
                <Merge className="mr-1.5 h-3.5 w-3.5" />
                {t("editor.actions.mergeNext")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("editor.actions.mergeNextTooltip")} <kbd className="ml-1 text-[10px] opacity-60">Ctrl+Shift+M</kbd></p>
            </TooltipContent>
          </Tooltip>
          {onRetranslate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={retranslating}
                  onClick={() => onRetranslate(line.id)}
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retranslating ? "animate-spin" : ""}`} />
                  {t("editor.actions.retranslate", "Retranslate")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("editor.actions.retranslateTooltip", "Retranslate this line")}</p>
              </TooltipContent>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive ml-auto"
                  onClick={() => onDelete(line.id)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("editor.delete")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("editor.deleteTooltip")} <kbd className="ml-1 text-[10px] opacity-60">Del</kbd></p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>

      <Separator />

      {/* Original text */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">{t("editor.originalText")}</Label>
        <Textarea
          value={line.original_text}
          onChange={(e) => onUpdateLine(line.id, { original_text: e.target.value, status: "editing" })}
          rows={3}
          className="resize-none text-sm"
        />
      </div>

      {/* Add to Vocabulary */}
      {vocabularies && onUpdateVocabulary && (
        <Popover open={vocabOpen} onOpenChange={setVocabOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <BookPlus className="mr-1.5 h-3.5 w-3.5" />
              {t("editor.vocab.addToVocab")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="start">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t("editor.vocab.addToVocab")}</p>
              <AddToVocabForm
                vocabularies={vocabularies}
                onUpdateVocabulary={onUpdateVocabulary}
                onDone={() => setVocabOpen(false)}
              />
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Translated text */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">{t("editor.translatedText")}</Label>
        <Textarea
          value={line.translated_text}
          onChange={(e) => onUpdateLine(line.id, { translated_text: e.target.value, status: "editing" })}
          rows={3}
          className="resize-none text-sm"
          placeholder={t("editor.translationPlaceholder")}
        />
      </div>

      <Separator />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<Type className="h-3 w-3" />} label={t("editor.stats.chars")} value={String(charCount)} />
        <StatCard icon={<Clock className="h-3 w-3" />} label={t("editor.stats.duration")} value={`${duration.toFixed(1)}s`} />
        <StatCard icon={<Type className="h-3 w-3" />} label={t("editor.stats.cps")} value={String(cps)} />
      </div>
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
        {icon}
        <span className="text-[10px]">{label}</span>
      </div>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}
