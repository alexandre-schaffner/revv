# TanStack Query Best Practices

## Query Key Convention

```ts
// Hierarchical, deterministic keys
['todos']
['todos', 'list']
['todos', { status: 'done' }]
['todos', todoId, 'details']
['users', userId, 'posts']
```

## Stale vs Cache Time

```ts
// Data fresh for 5 min; unused after 10 min
staleTime: 5 * 60 * 1000
gcTime: 10 * 60 * 1000
```

## Invalidation Strategy

```ts
// Invalidate exact key
queryClient.invalidateQueries({ queryKey: ['todos', todoId] });

// Invalidate all with prefix
queryClient.invalidateQueries({ queryKey: ['todos'] });

// Conditional invalidation
queryClient.invalidateQueries({
  queryKey: ['posts'],
  type: 'active'  // Only active queries
});
```

## Optimistic Updates

```ts
mutationFn: newData => updateTodo(newData),
onMutate: (newData) => {
  queryClient.setQueryData(['todos', newData.id], newData);
},
onError: (_err, _newData, context) => {
  queryClient.setQueryData(['todos', newData.id], context.prevData);
}
```

## Testing

Mock with QueryClient:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 }
  }
});

queryClient.setQueryData(['users'], mockData);
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Unstable query keys | Use static/derivable keys |
| Over-invalidating | Invalidate only affected queries |
| Missing enabled check | Use `enabled: !!dependency` |
| No error boundaries | Wrap with ErrorBoundary |
