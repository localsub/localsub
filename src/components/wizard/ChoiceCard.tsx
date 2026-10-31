import type { ReactNode } from "react";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

interface ChoiceCardProps {
  value: string;
  checked: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * One option of a wizard RadioGroup, rendered as a full-width card: soft
 * primary fill with an inset ring when selected, muted surface otherwise.
 */
export function ChoiceCard({ value, checked, className, children }: ChoiceCardProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3.5 rounded-lg px-[18px] transition-[background-color,box-shadow] duration-150 ease-out",
        checked
          ? "bg-primary-soft shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
          : "bg-muted hover:bg-muted-hover",
        className,
      )}
    >
      <RadioGroupItem value={value} />
      {children}
    </label>
  );
}
