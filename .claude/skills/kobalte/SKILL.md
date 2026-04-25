---
name: kobalte
description: Headless accessible UI primitives for SolidJS. Unstyled, composable, keyboard-accessible component library built with a11y-first approach
when_to_use: When building accessible UI components with SolidJS, need Dialog/Select/Popover/Tabs, or combining with custom CSS/Tailwind styling
---

# Kobalte (v0.13.x)

Headless, accessible UI primitives for SolidJS. No styling included — compose with CSS/Tailwind. Full keyboard navigation, ARIA support, and screen reader friendly.

## Core Concept

Components are **unstyled building blocks** with sensible defaults and data attributes for styling:

```tsx
import { Dialog } from '@kobalte/core/dialog';

<Dialog>
  <Dialog.Trigger class="btn">Open</Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="overlay" />
    <Dialog.Content class="dialog">
      <Dialog.Title>Title</Dialog.Title>
      <Dialog.Description>Description</Dialog.Description>
      <Dialog.CloseButton>Close</Dialog.CloseButton>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog>
```

## Core Primitives

| Component | Purpose |
|-----------|---------|
| Dialog | Modal dialog / alert |
| Popover | Floating content anchored to trigger |
| Select | Dropdown select with keyboard nav |
| Combobox | Searchable select |
| Tabs | Tabbed interface |
| Accordion | Collapsible panels |
| Tooltip | Hover/focus tooltip |
| DropdownMenu | Context menu or dropdown |
| ContextMenu | Right-click menu |
| Toast | Notifications |
| Checkbox | Checkbox input |
| Radio | Radio button |
| Switch | Toggle switch |
| Slider | Slider input |
| Textfield | Text input with validation |
| Textarea | Multi-line text input |

## Key Features

- **Polymorphic `as` prop** — render as any element: `<Button as="a" href="/home">`
- **Data attributes** — target styling with `data-disabled`, `data-readonly`, `data-required`
- **Unstyled** — bring your own CSS or TailwindCSS
- **Full keyboard support** — arrow keys, Tab, Enter, Escape
- **ARIA attributes** — all included automatically
- **Screen reader friendly** — proper roles and labels

## Learn More

- Components reference: [api-reference.md](api-reference.md)
- Code examples: [examples.md](examples.md)
- Accessibility patterns: [best-practices.md](best-practices.md)
- Docs: https://kobalte.dev
