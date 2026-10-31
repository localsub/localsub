import * as ProgressPrimitive from "@radix-ui/react-progress";

interface Props {
  value: number;
  max?: number;
}

export function Progress({ value, max = 100 }: Props) {
  const pct = Math.round((value / max) * 100);

  return (
    <div className="flex items-center gap-3">
      <ProgressPrimitive.Root
        value={value}
        max={max}
        className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <ProgressPrimitive.Indicator
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </ProgressPrimitive.Root>
      <span className="min-w-10 text-right text-sm font-bold tabular-nums text-primary-text">
        {pct}%
      </span>
    </div>
  );
}
