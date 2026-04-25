# SolidJS Best Practices

## Props Reactivity

❌ **Bad:** Destructuring loses reactivity
```ts
function Component({ count }) {
  createEffect(() => console.log(count)); // Won't re-run
}
```

✅ **Good:** Access via props object or splitProps
```ts
function Component(props) {
  createEffect(() => console.log(props.count));
}
```

## Memoize Expensive Computations

```ts
// Cache filter result; only recalculate if items() changes
const filtered = createMemo(() => items().filter(i => i.active));
```

## Batch Multiple Updates

```ts
batch(() => { setA(1); setB(2); setC(3); }); // 1 reaction
```

## Use Keys in Lists

```tsx
<For each={items()} keyed={(item) => item.id}>
  {(item) => <Item item={item} />}
</For>
```

## Stores for Nested State

```ts
// createStore: fine-grained updates
const [state, setState] = createStore({ user: { name: 'Alice' } });
setState('user', 'name', 'Bob');
```

## Suspense for Async

```tsx
<Suspense fallback={<Loading />}>
  <UserProfile userId={id()} />
</Suspense>
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Destructure props | Use `props.field` or `splitProps()` |
| Create signals outside component | Create inside setup function |
| Mutate store directly | Use `setState()` or `produce()` |
| Forget keys in `<For>` | Always use `keyed` prop |
| Over-memoization | Only memo expensive computations |
