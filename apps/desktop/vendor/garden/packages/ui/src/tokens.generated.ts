// Garden token bindings — generated. DO NOT EDIT.
// Source of truth: contracts/tokens/garden.tokens.json (run scripts/build-tokens.mjs)
export const gardenTokens = {
  "$schema": "./tokens.schema.json",
  "meta": {
    "name": "Garden UI",
    "id": "garden-ui",
    "version": "0.1.0",
    "derived_from": "Codex desktop app design system (extracted 2026-09, ChatGPT.app v26.917.71314) + beautifului.dev component topology (MIT, Shane Levine)",
    "philosophy": "monochrome chrome, luminance hierarchy, inverse primary action, alpha borders, hairline depth, terminal heritage, symmetric dark/light ramp",
    "tokens_are": "single source of truth — web bindings are generated from this file"
  },
  "color": {
    "primitive": {
      "gray": {
        "0": "#ffffff",
        "25": "#fcfcfc",
        "50": "#f9f9f9",
        "75": "#f3f3f3",
        "100": "#ededed",
        "150": "#dfdfdf",
        "200": "#cdcdcd",
        "250": "#b9b9b9",
        "300": "#afafaf",
        "350": "#9f9f9f",
        "400": "#8f8f8f",
        "450": "#767676",
        "500": "#5d5d5d",
        "550": "#4f4f4f",
        "600": "#414141",
        "650": "#393939",
        "700": "#303030",
        "750": "#282828",
        "800": "#212121",
        "850": "#1c1c1c",
        "900": "#181818",
        "925": "#161616",
        "950": "#131313",
        "975": "#101010",
        "1000": "#0d0d0d",
        "_rule": "theme-symmetric: dark inverts the scale (gray-0 ↔ gray-1000), gray-500 shared"
      },
      "blue": {
        "50": "#e5f3ff",
        "200": "#66b5ff",
        "300": "#339cff",
        "400": "#0285ff",
        "500": "#0169cc",
        "900": "#00284d"
      },
      "green": {
        "50": "#d9f4e4",
        "300": "#40c977",
        "400": "#04b84c",
        "500": "#00a240"
      },
      "red": {
        "50": "#ffd9d9",
        "300": "#ff6764",
        "400": "#fa423e",
        "500": "#e02e2a"
      },
      "orange": {
        "50": "#ffe7d9",
        "300": "#ff8549",
        "400": "#fb6a22",
        "500": "#e25507"
      },
      "purple": {
        "300": "#ad7bf9",
        "400": "#924ff7"
      },
      "yellow": {
        "400": "#ffc300"
      }
    },
    "semantic": {
      "ink": {
        "light": "#1a1c1f",
        "dark": "#dfdfdf",
        "maps": {
          "garden": "text.foreground",
          "shadcn": "foreground",
          "beautifului": "ink"
        }
      },
      "ink2": {
        "expr": {
          "ref": "ink",
          "alpha": 0.65
        },
        "maps": {
          "garden": "text.secondary",
          "shadcn": "muted-foreground",
          "beautifului": "ink-2"
        }
      },
      "ink3": {
        "expr": {
          "ref": "ink",
          "alpha": 0.45
        },
        "maps": {
          "garden": "text.tertiary",
          "shadcn": "accent-foreground-dim",
          "beautifului": "ink-3"
        }
      },
      "page": {
        "light": "#f9f9f9",
        "dark": "#212121",
        "maps": {
          "garden": "surface.page",
          "shadcn": "—",
          "beautifului": "page"
        }
      },
      "canvas": {
        "light": "#ffffff",
        "dark": "#181818",
        "maps": {
          "garden": "surface.canvas",
          "shadcn": "background",
          "beautifului": "canvas"
        }
      },
      "surface": {
        "light": "#ffffff",
        "dark": "#212121",
        "maps": {
          "garden": "surface.card",
          "shadcn": "card + popover",
          "beautifului": "surface"
        }
      },
      "inset": {
        "light": "#f9f9f9",
        "dark": "#131313",
        "maps": {
          "garden": "surface.inset",
          "shadcn": "muted + secondary",
          "beautifului": "inset"
        }
      },
      "hover": {
        "expr": {
          "ref": "ink",
          "alpha": 0.05
        },
        "maps": {
          "garden": "state.hover",
          "shadcn": "accent",
          "beautifului": "hover"
        }
      },
      "hover2": {
        "expr": {
          "ref": "ink",
          "alpha": 0.08
        },
        "maps": {
          "garden": "state.active",
          "shadcn": "accent-pressed",
          "beautifului": "hover-2"
        }
      },
      "line": {
        "expr": {
          "ref": "ink",
          "alpha": 0.08
        },
        "maps": {
          "garden": "border.default",
          "shadcn": "border",
          "beautifului": "line"
        }
      },
      "lineStrong": {
        "expr": {
          "ref": "ink",
          "alpha": 0.12
        },
        "maps": {
          "garden": "border.strong",
          "shadcn": "input",
          "beautifului": "line-strong"
        }
      },
      "field": {
        "light": "#f9f9f9",
        "dark": "#212121",
        "maps": {
          "garden": "surface.field",
          "shadcn": "—",
          "beautifului": "field"
        }
      },
      "stripe": {
        "expr": {
          "ref": "ink",
          "alpha": 0.07
        },
        "maps": {
          "garden": "pattern.stripe",
          "shadcn": "—",
          "beautifului": "stripe"
        }
      },
      "stripeBg": {
        "light": "#f3f3f3",
        "dark": "#161616",
        "maps": {
          "garden": "pattern.stripeBg",
          "shadcn": "—",
          "beautifului": "stripe-bg"
        }
      },
      "accent": {
        "light": "#0285ff",
        "dark": "#339cff",
        "maps": {
          "garden": "focus/link/selection",
          "shadcn": "ring",
          "beautifului": "accent"
        },
        "note": "focus · links · selection — never the primary button fill"
      },
      "accentInk": {
        "light": "#0169cc",
        "dark": "#66b5ff",
        "maps": {
          "garden": "focus.text",
          "shadcn": "—",
          "beautifului": "accent-ink"
        }
      },
      "accentTint": {
        "light": "#e5f3ff",
        "dark": {
          "hex": "#339cff",
          "alpha": 0.16
        },
        "maps": {
          "garden": "selection.fill",
          "shadcn": "—",
          "beautifului": "accent-tint"
        }
      },
      "success": {
        "light": "#00a240",
        "dark": "#40c977",
        "maps": {
          "garden": "status.success",
          "shadcn": "chart-2",
          "beautifului": "green"
        }
      },
      "successTint": {
        "light": "#d9f4e4",
        "dark": {
          "hex": "#04b84c",
          "alpha": 0.15
        },
        "maps": {
          "garden": "status.successFill",
          "shadcn": "—",
          "beautifului": "green-tint"
        }
      },
      "warning": {
        "light": "#e25507",
        "dark": "#ff8549",
        "maps": {
          "garden": "status.warning",
          "shadcn": "chart-4",
          "beautifului": "orange"
        }
      },
      "warningTint": {
        "light": "#ffe7d9",
        "dark": {
          "hex": "#fb6a22",
          "alpha": 0.16
        },
        "maps": {
          "garden": "status.warningFill",
          "shadcn": "—",
          "beautifului": "orange-tint"
        }
      },
      "danger": {
        "light": "#e02e2a",
        "dark": "#ff6764",
        "maps": {
          "garden": "status.danger",
          "shadcn": "destructive",
          "beautifului": "red"
        }
      },
      "dangerTint": {
        "light": "#ffd9d9",
        "dark": {
          "hex": "#fa423e",
          "alpha": 0.16
        },
        "maps": {
          "garden": "status.dangerFill",
          "shadcn": "—",
          "beautifului": "red-tint"
        }
      },
      "brand": {
        "light": "#924ff7",
        "dark": "#ad7bf9",
        "maps": {
          "garden": "brand.codex",
          "shadcn": "chart-4",
          "beautifului": "—"
        }
      },
      "primary": {
        "light": "#181818",
        "dark": "#ededed",
        "maps": {
          "garden": "action.primary.fill",
          "shadcn": "primary",
          "beautifului": "—"
        },
        "note": "inverse monochrome — light: near-black fill; dark: near-white fill"
      },
      "primaryInk": {
        "light": "#ffffff",
        "dark": "#0d0d0d",
        "maps": {
          "garden": "action.primary.text",
          "shadcn": "primary-foreground",
          "beautifului": "—"
        }
      },
      "tooltipBg": {
        "light": "#1c1c1c",
        "dark": "#101010",
        "maps": {
          "beautifului": "tooltip-bg"
        }
      },
      "tooltipFg": {
        "light": "#fcfcfc",
        "dark": "#ededed",
        "maps": {
          "beautifului": "tooltip-fg"
        }
      },
      "tooltipMuted": {
        "light": "#9a9da3",
        "dark": "#8f8f8f",
        "maps": {
          "beautifului": "tooltip-muted"
        }
      },
      "tooltipLine": {
        "light": "#303030",
        "dark": "#212121",
        "maps": {
          "beautifului": "tooltip-border"
        }
      }
    }
  },
  "typography": {
    "family": {
      "ui": {
        "web": "var(--font-inter), Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "note": "React ships Inter; the CSS stack falls back to the system sans-serif face"
      },
      "mono": {
        "web": "var(--font-mono-face), 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
      }
    },
    "scale_px": {
      "micro": {
        "size": 11,
        "line": 1.33
      },
      "caption": {
        "size": 12,
        "line": 1.43
      },
      "ui": {
        "size": 13,
        "line": 1.45
      },
      "body": {
        "size": 14,
        "line": 1.5
      },
      "bodyLg": {
        "size": 16,
        "line": 1.56
      },
      "headingSm": {
        "size": 18,
        "line": 1.4
      },
      "heading": {
        "size": 20,
        "line": 1.35
      },
      "headingLg": {
        "size": 24,
        "line": 1.3
      },
      "mono": {
        "size": 12,
        "line": 1.6
      }
    },
    "weights": {
      "regular": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    },
    "tracking": {
      "tight": "-0.025em",
      "normal": "0em",
      "wide": "0.025em"
    }
  },
  "spacing": {
    "unit_px": 4,
    "grid": [
      4,
      8,
      12,
      16,
      20,
      24,
      32,
      40,
      48,
      64
    ],
    "component": {
      "controlHeight": 28,
      "controlHeightSm": 20,
      "navRowHeight": 29,
      "toolbarHeight": 46,
      "sidebarWidth": "clamp(240px, 275px, min(520px, 100vw - 320px))",
      "composerMinHeight": 44,
      "itemGap": 16,
      "itemGapGrouped": 4
    },
    "layout": {
      "pageGutter": 32,
      "pageGutterCompact": 16,
      "contentMax": 960,
      "documentMax": 760,
      "settingsMax": 760,
      "settingsNav": 240,
      "panelWidth": 300,
      "sectionGap": 32,
      "groupGap": 24,
      "rowGap": 16,
      "fieldGap": 8,
      "propertyLabelWidth": 144,
      "settingsRowMinHeight": 64,
      "panelHeaderHeight": 46,
      "railWidth": 52,
      "settingsTopPadding": 72
    }
  },
  "radius": {
    "note": "Corner radii follow the Garden superellipse scale",
    "chip": 6,
    "control": 8,
    "card": 10,
    "lg": 12.5,
    "xl": 15,
    "composer": 28,
    "pill": 9999
  },
  "shadow": {
    "note": "elevation = hairline ring + very soft stack; dark mode keeps the same formulas (rings resolve via --line)",
    "hairline": "0 0 0 1px <line>",
    "btn": "0 0 0 1px <lineStrong>, 0 1px 2px rgba(16,24,40,0.05)",
    "card": "0 0 0 1px <line>, 0 1px 2px rgba(16,24,40,0.04), 0 2px 6px rgba(16,24,40,0.03)",
    "raised": "0 0 0 1px <line>, 0 2px 10px rgba(0,0,0,0.04)",
    "overlay": "0 0 0 1px <line>, 0 8px 28px rgba(0,0,0,0.06)",
    "composer": "0 0 0 1px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.04), 0 4px 80px 8px rgba(0,0,0,0.02)",
    "insetField": "inset 0 1px 2px rgba(0,0,0,0.12)"
  },
  "motion": {
    "durations_ms": {
      "fast": 150,
      "base": 200,
      "relaxed": 300,
      "slow": 500
    },
    "default": "cubic-bezier(0.4, 0, 0.2, 1) 150ms",
    "curves": {
      "enter": {
        "css": "cubic-bezier(0.19, 1, 0.22, 1)"
      },
      "exit": {
        "css": "cubic-bezier(0.8, 0, 0.4, 1)"
      },
      "exitSnappy": {
        "css": "cubic-bezier(0.65, 0, 0.4, 1)"
      },
      "move": {
        "css": "cubic-bezier(0.65, 0, 0.35, 1)"
      }
    },
    "reduced_motion": "all durations collapse to 0; states crossfade instantly"
  }
} as const;
export type GardenTokens = typeof gardenTokens;
