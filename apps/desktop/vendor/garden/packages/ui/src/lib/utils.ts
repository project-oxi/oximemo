import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"
import { gardenTokens } from "../tokens.generated"

// Garden's named sizes must remain independent of text colors. Otherwise
// `text-ui text-ink` is merged as two colors and silently loses its size.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: Object.keys(gardenTokens.typography.scale_px) } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
