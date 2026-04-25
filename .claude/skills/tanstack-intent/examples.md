# TanStack Intent Examples

```ts
const intents = {
  'create': () => { /* ... */ },
  'save': () => { /* ... */ }
}

<button onClick={() => intents['create']()}>Create</button>
<Hotkey keys="ctrl+s" intent="save" />
```
