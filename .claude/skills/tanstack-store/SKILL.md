---
name: tanstack-store
description: Framework-agnostic reactive store library. Observable state with fine-grained reactivity, adapters for React, Solid, Vue
when_to_use: When you need cross-framework state, reactive stores without framework coupling, or simple observable patterns
---

# TanStack Store (v0.9.x)

Framework-agnostic, observable state library. Core is pure TypeScript; framework adapters (React, Solid, Vue) add hooks.

## Core API

```ts
import { Store } from '@tanstack/store'

const store = new Store({
  count: 0,
  user: { name: 'Alice' }
})

store.setState(s => ({ ...s, count: 1 }))
store.subscribe(state => console.log(state))
```

## Framework Adapters

```ts
// React
const state = useStore(store)

// Solid
const state = createStore(store)

// Vue
const state = useStore(store)
```
