# SolidJS Examples

## Counter
```ts
import { createSignal } from 'solid-js';

export function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <div>
      <p>Count: {count()}</p>
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
    </div>
  );
}
```

## Fetch Data
```ts
import { createResource, Suspense, Show } from 'solid-js';

const [user] = createResource(
  () => userId(),
  async (id) => fetch(`/api/users/${id}`).then(r => r.json())
);

<Suspense fallback={<div>Loading...</div>}>
  <Show when={user()}>{(u) => <div>{u().name}</div>}</Show>
</Suspense>
```

## Store
```ts
const [state, setState] = createStore({ count: 0, user: { name: 'Alice' } });
setState('user', 'name', 'Bob'); // Deep update
setState(produce((s) => { s.count++; })); // Multiple changes
```

## Derived State
```ts
const [items, setItems] = createSignal([...]);
const total = createMemo(() => items().reduce((s, i) => s + i.price, 0));
```

## Form Validation
```ts
const [email, setEmail] = createSignal('');
const errors = createMemo(() => {
  const e: Record<string, string> = {};
  if (email() && !email().includes('@')) e.email = 'Invalid';
  return e;
});
const isValid = createMemo(() => Object.keys(errors()).length === 0);
```

## List Rendering
```ts
<For each={todos()} keyed={(t) => t.id}>
  {(todo) => (
    <li>
      <input type="checkbox" checked={todo.done} />
      <span>{todo.text}</span>
    </li>
  )}
</For>
```

## Testing
```ts
import { render, screen } from 'solid-testing-library';

it('increments', async () => {
  render(() => <Counter />);
  screen.getByRole('button').click();
  expect(screen.getByText('Count: 1')).toBeInTheDocument();
});
```
