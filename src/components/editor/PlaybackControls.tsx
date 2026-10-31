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
    <div className="flex h-10 items-center gap-4 px-1.5 text-foreground-secondary">
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm [&_svg]:size-[18px]" onClick={onSkipPrev} aria-label={t("editor.a11y.skipPrev")}>
          <SkipBack />
        </Button>
        <Button
          size="icon"
          className="h-[38px] w-[38px] rounded-full [&_svg]:size-4"
          onClick={onTogglePlay}
          aria-label={isPlaying ? t("editor.a11y.pause") : t("editor.a11y.play")}
        >
          {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" className="ml-0.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm [&_svg]:size-[18px]" onClick={onSkipNext} aria-label={t("editor.a11y.skipNext")}>
          <SkipForward />
        </Button>
      </div>

      <span className="w-[72px] text-sm font-semibold tabular-nums text-foreground">
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

      <span className="w-[72px] text-right text-sm tabular-nums text-muted-foreground">
        {formatTime(duration)}
      </span>

      {/* Playback speed */}
      <Select value={String(playbackRate)} onValueChange={(v) => onPlaybackRateChange(Number(v))}>
        <SelectTrigger
          aria-label={t("editor.playbackSpeed")}
          className="h-8 w-auto gap-1 rounded-[9px] px-2.5 text-[13px] font-bold text-foreground [&>svg]:size-3.5"
        >
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
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm [&_svg]:size-[18px]" aria-label={t("editor.a11y.volume")}>
            <VolumeIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-44 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <VolumeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
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
