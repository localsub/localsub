import { useRef, useEffect, useMemo, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Scissors, Merge, Trash2, BookPlus } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { RefusalReason } from "@/lib/refusalDetect"
import { cn } from "@/lib/utils"
import { buildVocabPrefill, type VocabPrefill } from "@/lib/vocabPrefill"
import { AddToVocabDialog } from "./AddToVocabDialog"
import type { SubtitleLine, Vocabulary } from "@/types"
import type { SearchMatch } from "./EditorPage"

interface SubtitleListProps {
  lines: SubtitleLine[]
  selectedId: string | null
  currentTime: number
  onSelect: (id: string) => void
  onSeek?: (time: number) => void
  onSplit: (id: string) => void
  onMergeWithNext: (id: string) => void
  onDelete?: (id: string) => void
  highlightMatches?: SearchMatch[]
  currentMatchIndex?: number
  vocabularies?: Vocabulary[]
  /** Enables "add selection to vocabulary" in the line context menu */
  onUpdateVocabulary?: (v: Vocabulary) => Promise<Vocabulary[]>
  readOnly?: boolean
  /** lineId → refusal reason; flagged lines get the amber warning treatment */
  refusals?: Map<string, RefusalReason>
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`
}

function HighlightedText({
  text,
  matches,
  allMatches,
  currentMatchIndex,
}: {
  text: string
  matches: SearchMatch[]
  allMatches: SearchMatch[]
  currentMatchIndex: number
}) {
  if (matches.length === 0) return <>{text}</>

  const sorted = [...matches].sort((a, b) => a.startIdx - b.startIdx)
  const parts: React.ReactNode[] = []
  let cursor = 0

  for (const match of sorted) {
    if (match.startIdx > cursor) {
      parts.push(text.slice(cursor, match.startIdx))
    }
    const globalIdx = allMatches.indexOf(match)
    const isCurrent = globalIdx === currentMatchIndex
    parts.push(
      <mark
        key={`${match.startIdx}-${match.length}`}
        className={isCurrent ? "rounded-[4px] bg-status-warning px-0.5 text-white" : "rounded-[4px] bg-status-warning-soft px-0.5 text-foreground"}
      >
        {text.slice(match.startIdx, match.startIdx + match.length)}
      </mark>,
    )
    cursor = match.startIdx + match.length
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}

interface VocabTerm {
  source: string
  target: string
}

function VocabHighlightedText({
  text,
  vocabTerms,
  vocabRegex,
}: {
  text: string
  vocabTerms: VocabTerm[]
  vocabRegex: RegExp | null
}) {
  if (!vocabRegex || vocabTerms.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  vocabRegex.lastIndex = 0
  while ((match = vocabRegex.exec(text)) !== null) {
    const matchedText = match[0]
    const idx = match.index

    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx))
    }

    // Find matching vocab term (case-insensitive)
    const term = vocabTerms.find((t) => t.source.toLowerCase() === matchedText.toLowerCase())

    parts.push(
      <span
        key={idx}
        className="underline decoration-dotted decoration-primary/60 underline-offset-2 cursor-help"
        title={term ? `→ ${term.target}` : undefined}
      >
        {text.slice(idx, idx + matchedText.length)}
      </span>,
    )
    lastIndex = idx + matchedText.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

const STATUS_CHIP: Record<string, string> = {
  translated: "bg-status-success-soft text-status-success",
  untranslated: "bg-muted text-foreground-secondary",
  spell_error: "bg-status-error-soft text-status-error",
  editing: "bg-primary-soft text-primary-text",
}

export function SubtitleList({ lines, selectedId, currentTime, onSelect, onSeek, onSplit, onMergeWithNext, onDelete, highlightMatches, currentMatchIndex, vocabularies, onUpdateVocabulary, readOnly, refusals }: SubtitleListProps) {
  const { t } = useTranslation()
  const selectedRef = useRef<HTMLDivElement>(null)
  const lastLineRef = useRef<HTMLDivElement>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // "Add selection to vocabulary": selection captured at right-click time
  // (the context menu itself can steal/clear it later), and the prefill
  // currently shown in the dialog.
  const [selectionPrefill, setSelectionPrefill] = useState<VocabPrefill | null>(null)
  const [vocabDialogPrefill, setVocabDialogPrefill] = useState<VocabPrefill | null>(null)

  const handleRowContextMenu = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setSelectionPrefill(null)
      return
    }
    const toCell = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement ?? null
      return el?.closest("[data-vocab-side]") ?? null
    }
    // 원문/번역에 걸친(또는 행을 넘는) 선택은 한쪽 용어가 아니므로 제외
    const anchorCell = toCell(sel.anchorNode)
    const focusCell = toCell(sel.focusNode)
    if (!anchorCell || anchorCell !== focusCell) {
      setSelectionPrefill(null)
      return
    }
    const side = anchorCell.getAttribute("data-vocab-side")
    if (side !== "original" && side !== "translated") {
      setSelectionPrefill(null)
      return
    }
    setSelectionPrefill(buildVocabPrefill(sel.toString(), side))
  }, [])

  // Auto-scroll to last line in readOnly/live mode
  useEffect(() => {
    if (readOnly && lastLineRef.current) {
      lastLineRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
  }, [readOnly, lines.length])

  // Pre-compile vocab terms and regex for highlighting
  const { vocabTerms, vocabRegex } = useMemo(() => {
    if (!vocabularies || vocabularies.length === 0) return { vocabTerms: [], vocabRegex: null }
    const terms: VocabTerm[] = []
    for (const vocab of vocabularies) {
      for (const entry of vocab.entries) {
        if (entry.source.trim()) {
          terms.push({ source: entry.source, target: entry.target })
        }
      }
    }
    if (terms.length === 0) return { vocabTerms: terms, vocabRegex: null }
    // Sort by length descending so longer terms match first
    terms.sort((a, b) => b.source.length - a.source.length)
    const escaped = terms.map((t) => t.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    const regex = new RegExp(`(${escaped.join("|")})`, "gi")
    return { vocabTerms: terms, vocabRegex: regex }
  }, [vocabularies])

  // Auto-scroll to selected (delayed to avoid interfering with double-click)
  useEffect(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = setTimeout(() => {
      if (selectedRef.current) {
        selectedRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" })
      }
    }, 300)
    return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current) }
  }, [selectedId])

  if (lines.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-center">
        <p className="text-[15px] text-muted-foreground">
          {t("editor.noSubtitles")}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1 p-2">
        {lines.map((line, lineIndex) => {
          const isSelected = line.id === selectedId
          const isActive = !isSelected && currentTime >= line.start_time && currentTime <= line.end_time
          const duration = line.end_time - line.start_time
          const splitDisabled = readOnly || duration < 0.5
          const mergeDisabled = readOnly || lineIndex >= lines.length - 1
          const isLast = lineIndex === lines.length - 1
          const refusalReason = refusals?.get(line.id)

          return (
            <ContextMenu key={line.id}>
              <ContextMenuTrigger asChild>
                <div
                  ref={isSelected ? selectedRef : isLast && readOnly ? lastLineRef : undefined}
                  className={cn(
                    "grid cursor-pointer select-none grid-cols-[56px_minmax(0,1fr)_auto] gap-3.5 rounded-[14px] px-3.5 py-3 transition-colors duration-150",
                    isSelected
                      ? "bg-primary-soft"
                      : refusalReason
                        ? "bg-status-warning-soft"
                        : isActive
                          ? "bg-muted"
                          : "hover:bg-muted",
                    isActive && refusalReason && !isSelected && "shadow-[inset_0_0_0_2px_hsl(var(--status-warning)/0.45)]",
                    "data-[state=open]:shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.35)]",
                  )}
                  onClick={() => onSelect(line.id)}
                  onDoubleClick={() => onSeek?.(line.start_time + 0.01)}
                  onContextMenu={handleRowContextMenu}
                >
                  {/* Index + time */}
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-bold tabular-nums">
                      {line.index}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatTimestamp(line.start_time)}
                    </span>
                  </div>

                  {/* Text content */}
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="select-text text-[15px] font-semibold leading-snug" data-vocab-side="original">
                      {highlightMatches ? (
                        <HighlightedText
                          text={line.original_text}
                          matches={highlightMatches.filter((m) => m.lineId === line.id && m.field === "original")}
                          allMatches={highlightMatches}
                          currentMatchIndex={currentMatchIndex ?? -1}
                        />
                      ) : (
                        <VocabHighlightedText
                          text={line.original_text}
                          vocabTerms={vocabTerms}
                          vocabRegex={vocabRegex}
                        />
                      )}
                    </p>
                    {line.translated_text && (
                      <p className="select-text text-[15px] font-medium leading-snug text-primary-text" data-vocab-side="translated">
                        {highlightMatches ? (
                          <HighlightedText
                            text={line.translated_text}
                            matches={highlightMatches.filter((m) => m.lineId === line.id && m.field === "translated")}
                            allMatches={highlightMatches}
                            currentMatchIndex={currentMatchIndex ?? -1}
                          />
                        ) : (
                          line.translated_text
                        )}
                      </p>
                    )}
                    {line.speaker && (
                      <span className="text-xs text-muted-foreground">[{line.speaker}]</span>
                    )}
                    {refusalReason && (
                      <span className="flex items-center gap-1.5 text-[12.5px] font-bold text-status-warning">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {t(`editor.refusal.reason.${refusalReason}`)}
                      </span>
                    )}
                  </div>

                  {/* Status chip — on a flagged row it sits on the card so it reads against the amber */}
                  <span
                    className={cn(
                      "inline-flex h-6 items-center self-start whitespace-nowrap rounded-[7px] px-2 text-xs font-bold",
                      refusalReason && !isSelected
                        ? "bg-card text-status-warning"
                        : STATUS_CHIP[line.status] ?? STATUS_CHIP.untranslated,
                    )}
                  >
                    {t(`editor.status.${line.status}` as never)}
                  </span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[260px]">
                <ContextMenuItem
                  disabled={splitDisabled}
                  onClick={() => onSplit(line.id)}
                >
                  <Scissors />
                  {t("editor.actions.split")}
                  <ContextMenuShortcut>Ctrl+Shift+S</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={mergeDisabled}
                  onClick={() => onMergeWithNext(line.id)}
                >
                  <Merge />
                  {t("editor.actions.mergeNext")}
                  <ContextMenuShortcut>Ctrl+Shift+M</ContextMenuShortcut>
                </ContextMenuItem>
                {onUpdateVocabulary && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={!selectionPrefill}
                      onClick={() => {
                        if (selectionPrefill) setVocabDialogPrefill(selectionPrefill)
                      }}
                    >
                      <BookPlus />
                      {t("editor.vocab.addToVocab")}
                    </ContextMenuItem>
                  </>
                )}
                {onDelete && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => onDelete(line.id)}
                      className="text-status-error focus:text-status-error"
                    >
                      <Trash2 />
                      {t("editor.delete")}
                      <ContextMenuShortcut>Del</ContextMenuShortcut>
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      {onUpdateVocabulary && (
        <AddToVocabDialog
          open={vocabDialogPrefill !== null}
          onOpenChange={(open) => { if (!open) setVocabDialogPrefill(null) }}
          vocabularies={vocabularies ?? []}
          onUpdateVocabulary={onUpdateVocabulary}
          prefillSource={vocabDialogPrefill?.source ?? ""}
          prefillTarget={vocabDialogPrefill?.target ?? ""}
        />
      )}
    </ScrollArea>
  )
}
