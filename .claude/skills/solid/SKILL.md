---
name: solid
description: SolidJS reactive UI framework — fine-grained reactivity, signals, stores, control flow, and SSR for building web UIs
when_to_use: When writing SolidJS components, reactive state, control flow primitives, resources, context, stores, or SSR code
---

# SolidJS (v1.9.x)

SolidJS is a declarative UI library with fine-grained reactivity. Components run once; only reactive expressions re-execute when dependencies change. No virtual DOM, no diffing.

## Core Mental Model

1. **Components are setup functions** that execute once and return a DOM template
2. **Signals are reactive atoms** — `createSignal` returns a getter and setter
3. **Reactivity is automatic** — any signal read inside `createEffect`, `createMemo`, or JSX expression is tracked
4. **Props are reactive getters** — never destructure; use `splitProps` or access via function

## Key Primitives

| API | Purpose |
|-----|---------|
| `createSignal` | Reactive value (getter + setter) |
| `createEffect` | Side effect that re-runs on dependency change |
| `createMemo` | Derived/memoized reactive value |
| `createResource` | Async data with Suspense support |
| `createStore` | Deep reactive proxy object |
| `batch` | Bundle multiple updates into one sync |
| `on`, `onMount`, `onCleanup` | Event handlers, lifecycle |
| `Show`, `For`, `Switch`, `Match`, `Dynamic` | Control flow components |
| `createContext`, `useContext` | Dependency injection |

## Common Patterns

### Signals
```ts
const [count, setCount] = createSignal(0);
const increment = () => setCount(c => c + 1);
```

### Derived State
```ts
const doubled = createMemo(() => count() * 2);
```

### Effects
```ts
createEffect(() => {
  console.log('Count changed:', count());
});
```

### Stores
```ts
const [state, setState] = createStore({ user: { name: 'Alice' } });
setState('user', 'name', 'Bob'); // Deep mutation
```

### Async Data
```ts
const [data] = createResource(userId, async (id) => {
  return fetch(`/api/users/${id}`).then(r => r.json());
});

<Suspense fallback={<Loading />}>
  <Show when={data()}>{(data) => <div>{data().name}</div>}</Show>
</Suspense>
```

## Learn More

- Full API reference: [api-reference.md](api-reference.md)
- Code examples: [examples.md](examples.md)
- Best practices: [best-practices.md](best-practices.md)
- Docs: https://docs.solidjs.com
