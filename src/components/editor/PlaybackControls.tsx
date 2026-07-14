import { useTranslation } from "react-i18next"
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface PlaybackControlsProps {
  currentTime: number
  duration: number
  isPlaying: boolean
  volume: number
  playbackRate: number
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onSkipPrev: () => void
  onSkipNext: () => void
  onVolumeChange: (v: number) => void
  onPlaybackRateChange: (rate: number) => void
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`
}

export function PlaybackControls({
  currentTime,
  duration,
  isPlaying,
  volume,
  playbackRate,
  onTogglePlay,
  onSeek,
  onSkipPrev,
  onSkipNext,
  onVolumeChange,
  onPlaybackRateChange,
}: PlaybackControlsProps) {
  const { t } = useTranslation()
  const VolumeIcon = volume === 0 ? VolumeX : Volume2

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t bg-muted/20">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onSkipPrev} aria-label={t("editor.a11y.skipPrev")}>
          <SkipBack className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onTogglePlay} aria-label={isPlaying ? t("editor.a11y.pause") : t("editor.a11y.play")}>
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onSkipNext} aria-label={t("editor.a11y.skipNext")}>
          <SkipForward className="h-3.5 w-3.5" />
        </Button>
      </div>

      <span className="text-xs tabular-nums text-muted-foreground w-20">
        {formatTime(currentTime)}
      </span>

      <Slider
        value={[currentTime]}
        onValueChange={([v]) => onSeek(v)}
        min={0}
        max={Math.max(duration, 1)}
        step={Math.max(0.1, duration / 1000)}
        className="flex-1 cursor-pointer"
      />

      <span className="text-xs tabular-nums text-muted-foreground w-20 text-right">
        {formatTime(duration)}
      </span>

      {/* Playback speed */}
      <Select value={String(playbackRate)} onValueChange={(v) => onPlaybackRateChange(Number(v))}>
        <SelectTrigger className="h-7 w-16 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RATES.map((r) => (
            <SelectItem key={r} value={String(r)}>{r}x</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("editor.a11y.volume")}>
            <VolumeIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-40 p-3">
          <div className="flex items-center gap-2">
            <VolumeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Slider
              value={[volume]}
              onValueChange={([v]) => onVolumeChange(v)}
              min={0}
              max={1}
              step={0.05}
              className="flex-1"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
