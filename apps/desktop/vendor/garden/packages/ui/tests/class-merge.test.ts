import { describe, expect, test } from "bun:test"
import { cn } from "../src/lib/utils"
import { gardenTokens } from "../src/tokens.generated"

describe("Garden typography class precedence", () => {
  test("named type sizes survive foreground colors in either order", () => {
    for (const name of Object.keys(gardenTokens.typography.scale_px)) {
      expect(cn(`text-${name}`, "text-ink-2")).toBe(`text-${name} text-ink-2`)
      expect(cn("text-ink", `text-${name}`)).toBe(`text-ink text-${name}`)
    }
  })

  test("caller sizes and colors override their own groups independently", () => {
    expect(cn("text-caption text-ink", "text-ui text-red")).toBe("text-ui text-red")
    expect(cn("text-headingSm text-ink", "text-sm")).toBe("text-ink text-sm")
    expect(cn("text-ui text-ink", "text-[length:var(--text-body)]")).toBe("text-ink text-[length:var(--text-body)]")
  })

  test("state variants retain independent size and color precedence", () => {
    expect(cn("hover:text-caption hover:text-ink", "hover:text-ui hover:text-red")).toBe("hover:text-ui hover:text-red")
    expect(cn("text-ui/6 text-ink", "leading-tight")).toBe("text-ui/6 text-ink leading-tight")
  })
})
