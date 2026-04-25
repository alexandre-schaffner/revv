# TanStack Store Examples

```ts
const store = new Store({ count: 0 })
store.setState(s => ({ ...s, count: s.count + 1 }))

// React
const state = useStore(store)

// Solid
const state = createStore(store)
```
