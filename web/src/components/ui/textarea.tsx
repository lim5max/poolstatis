import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full resize-y rounded-field border border-input bg-card px-3 py-2 text-sm shadow-xs transition-[color,background-color,border-color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
