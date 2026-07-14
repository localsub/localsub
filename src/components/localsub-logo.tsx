import { cn } from "@/lib/utils"

interface LocalSubLogoProps {
  size?: "sm" | "md" | "lg"
  className?: string
}

export function LocalSubLogo({ size = "md", className }: LocalSubLogoProps) {
  const sizeMap = {
    sm: "h-8 w-8",
    md: "h-9 w-9",
    lg: "h-12 w-12",
  }

  return (
    <img
      src="/logo.png"
      alt="LocalSub"
      className={cn("shrink-0 object-contain", sizeMap[size], className)}
    />
  )
}
