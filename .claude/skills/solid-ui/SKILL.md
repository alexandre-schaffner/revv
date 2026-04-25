---
name: solid-ui
description: Solid UI component library for SolidJS. Use when building UIs with SolidJS, adding components, theming, or styling.
when_to_use: When working with Solid UI components, building SolidJS interfaces, or looking for pre-built accessible components
---

# Solid UI

**Version:** solidui-cli@0.7.2 (latest as of January 2026)
**Repository:** https://github.com/stefan-karger/solid-ui (1.4k+ stars)
**Docs:** https://www.solid-ui.com/docs/introduction
**License:** MIT

## What It Is

Solid UI is a **copy-paste component collection** for SolidJS -- not a traditional npm component library. You pick the components you need, the CLI copies them into your codebase, and you own the code entirely. It is an unofficial port of shadcn/ui and tremor-raw to the Solid ecosystem.

**There is no `solid-ui` npm package to install.** Components are scaffolded into your project via the `solidui-cli` CLI tool and then customized in place.

## How It Differs from Related Projects

| Project | Relationship |
|---|---|
| **shadcn/ui** | The original React library. Solid UI ports its component designs and philosophy to SolidJS. |
| **shadcn-solid** | An earlier, separate port of shadcn/ui to Solid (by hngngn). Solid UI is a newer, more comprehensive alternative with additional Tremor visualization components. |
| **Kobalte** | A headless, accessible component primitive library for SolidJS. Solid UI *uses* Kobalte internally for most components (Accordion, Dialog, Select, etc.). |
| **Corvu** | Another Solid primitive library. Solid UI uses Corvu for specific components (Drawer, Resizable). |
| **Ark UI** | Used by Solid UI for the Date Picker component specifically. |

## Core Concepts

### Component Ownership
Components are copied into `~/components/ui/` in your project. You modify them directly. No version-locking to an external package.

### Styling Stack
- **Tailwind CSS v3** for all styling
- **CSS variables** (HSL format) for theming via `:root` and `.dark` / `[data-kb-theme="dark"]`
- **class-variance-authority (CVA)** for variant management
- **clsx + tailwind-merge** via a `cn()` utility

### CLI Workflow
```bash
npx solidui-cli@latest init                    # Initialize project config + base styles
npx solidui-cli@latest add button dialog card  # Add specific components
```

The `init` command:
- Installs dependencies (`tailwindcss-animate`, `class-variance-authority`, `clsx`, `tailwind-merge`)
- Creates the `cn()` utility in `lib/utils.ts`
- Configures `tailwind.config.cjs` with design tokens
- Sets up CSS variables in your global stylesheet
- Creates `ui.config.json` for storing CLI configuration

The `add` command:
- Presents an interactive component picker (Space to select, A to toggle all, Enter to submit)
- Copies component source files into `~/components/ui/`
- Installs any additional dependencies the component needs (e.g., `@kobalte/core` for Dialog)

### Dark Mode
Uses Kobalte's `ColorModeProvider`. Two strategies:
- **SolidStart (SSR):** `cookieStorageManagerSSR` with `kb-color-mode` cookie
- **Vite (CSR):** `createLocalStorageManager` with local storage key

### Primitive Foundations
Most components delegate accessibility and behavior to underlying primitive libraries:
- **Kobalte** -- Accordion, Alert Dialog, Checkbox, Collapsible, Combobox, Context Menu, Dialog, Dropdown Menu, Hover Card, Menubar, Navigation Menu, Number Field, Pagination, Popover, Progress, Radio Group, Select, Separator, Sheet, Slider, Switch, Tabs, Toast, Toggle, Toggle Group, Tooltip
- **Corvu** -- Drawer, Resizable
- **Ark UI** -- Date Picker
- **Embla Carousel** -- Carousel
- **cmdk-solid** -- Command palette
- **Chart.js** -- Charts (Line, Bar, Pie, Donut, Bubble, Radar, Polar Area, Scatter)
- **solid-sonner** -- Sonner (toast notifications)
- **@tanstack/solid-table** -- Data Table (headless table with sorting, filtering, pagination)

## Component Catalog (50+ components)

### Layout
Flex, Grid, Separator, Aspect Ratio, Resizable, Sidebar, Collapsible

### Forms & Inputs
Button, Checkbox, Combobox, Date Picker, Label, Number Field, OTP Field, Radio Group, Select, Slider, Switch, Text Field, Toggle, Toggle Group

### Data Display
Avatar, Badge, Badge Delta, Bar List, Card, Data Table, Delta Bar, Progress, Progress Circle, Timeline

### Feedback
Alert, Callout, Sonner (toast), Toast

### Overlay
Alert Dialog, Command, Context Menu, Dialog, Drawer, Dropdown Menu, Hover Card, Menubar, Navigation Menu, Popover, Sheet, Tooltip

### Navigation
Breadcrumb, Carousel, Pagination, Tabs

### Visualization
Charts (Line, Bar, Pie, Donut, Bubble, Radar, Polar Area, Scatter)

## Supported Frameworks

- **SolidStart** (recommended, with SSR dark mode support)
- **Vite + SolidJS** (client-side only)
- **Astro**
- **Tauri**

## Key Dependencies

```
tailwindcss@3            # Styling
tailwindcss-animate      # Animation utilities
class-variance-authority # Variant management (cva)
clsx                     # Conditional class names
tailwind-merge           # Tailwind class deduplication
@kobalte/core            # Accessible primitives (most components)
corvu                    # Primitives (Drawer, Resizable)
```

## File Structure After Init

```
src/
  components/
    ui/
      button.tsx         # Each component is a standalone file you own
      dialog.tsx
      card.tsx
      ...
  lib/
    utils.ts             # cn() helper function
ui.config.json           # CLI configuration (componentDir, aliases, etc.)
tailwind.config.js       # Extended with Solid UI design tokens
```

## Supporting Files

- [api-reference.md](api-reference.md) -- All components with their subcomponents, props, variants, and imports
- [examples.md](examples.md) -- Copy-paste code examples for common patterns
- [best-practices.md](best-practices.md) -- Theming, accessibility, customization, and performance guidance
