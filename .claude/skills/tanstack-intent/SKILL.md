---
name: tanstack-intent
description: Intent-based interaction library for command palettes, hotkeys, and intent routing
when_to_use: When building command palettes, intent-driven UIs, or need framework-agnostic intent/hotkey handling
---

# TanStack Intent (v0.1.x)

Intent-based interaction library. Define intents (user actions), bind them to hotkeys/UI, execute them consistently.

## Core Concept

Intents are semantic actions independent of UI:

```ts
const intents = {
  'app:create': () => createNew(),
  'app:save': () => save(),
  'app:delete': () => delete()
}
```

Bind to hotkeys, command palette, buttons—reuse the same intent logic.
