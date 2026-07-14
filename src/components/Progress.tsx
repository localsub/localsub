import * as ProgressPrimitive from "@radix-ui/react-progress";

interface Props {
  value: number;
  max?: number;
}

export function Progress({ value, max = 100 }: Props) {
  const pct = Math.round((value / max) * 100);

  return (
    <div className="flex items-center gap-2.5 mb-1.5">
      <ProgressPrimitive.Root
        value={value}
        max={max}
        className="relative flex-1 h-2 overflow-hidden rounded bg-border"
      >
        <ProgressPrimitive.Indicator
          className="h-full rounded bg-linear-to-r from-primary to-accent transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </ProgressPrimitive.Root>
      <span className="text-xs font-semibold text-slate-400 min-w-9 text-right">
        {pct}%
      </span>
    </div>
  );
}
