# SolidJS API Reference

## Reactivity Primitives

### createSignal
```ts
const [value, setValue] = createSignal(initialValue, options?)
```
Returns a getter and setter. The getter is reactive; the setter triggers updates.

**Options:** `equals` (custom equality), `name` (devtools)

### createMemo
```ts
const derived = createMemo(() => expensiveComputation())
```
Memoizes a computation. Re-runs only when dependencies change.

### createEffect
```ts
createEffect(() => {
  console.log('Dependencies changed:', signal())
})
```
Runs side effects whenever dependencies change.

### createResource
```ts
const [data, { refetch, mutate }] = createResource(source, fetcher)
```
Async data fetcher. `source` is a signal; `fetcher(source)` loads data.

**States:** `data()`, `loading()`, `error()`

### batch
```ts
batch(() => { setA(1); setB(2); setC(3); })
```
Batches multiple updates into a single reaction.

### untrack
```ts
untrack(() => otherSignal())
```
Reads a signal without tracking as dependency.

### on
```ts
createEffect(on(() => signal(), (value) => { console.log(value) }))
```
Explicit dependency tracking.

## Stores

### createStore
```ts
const [state, setState] = createStore({ count: 0 })
```
Deep reactive proxy for nested state.

### produce
```ts
setState(produce((s) => { s.count++ }))
```
Immer-style mutations.

### reconcile
```ts
setState(reconcile(newData))
```
Smart merge into store.

## Lifecycle

### onMount
```ts
onMount(() => { console.log('mounted') })
```

### onCleanup
```ts
onCleanup(() => { unsubscribe() })
```

## Context

### createContext / useContext
```ts
const Context = createContext()
const value = useContext(Context)
```

## Control Flow Components

- `<Show when={condition()}>` — conditional rendering
- `<For each={items()}>` — list rendering with keying
- `<Switch>/<Match>` — switch statement UI
- `<Portal>` — render outside tree
- `<Dynamic component={Comp} />` — dynamic components
- `<Suspense fallback={...}>` — async boundaries
- `<ErrorBoundary fallback={...}>` — error catching

## Utilities

### splitProps
```ts
const [own, rest] = splitProps(props, ['color'])
```

### mergeProps
```ts
const merged = mergeProps(defaults, userProps)
```

### reactive
```ts
const proxy = reactive(obj)
```
