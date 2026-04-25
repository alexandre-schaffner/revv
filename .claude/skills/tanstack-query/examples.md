# TanStack Query Examples

## Fetch Data
```ts
const [users] = createResource(
  () => userId(),
  async (id) => fetch(`/api/users/${id}`).then(r => r.json())
);
```

## Mutation
```ts
const mutation = createMutation(() => ({
  mutationFn: async (data) => fetch('/api/todos', {
    method: 'POST',
    body: JSON.stringify(data)
  }).then(r => r.json()),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  }
}));

mutation.mutate({ title: 'New todo' });
```

## Infinite Query
```ts
const query = createInfiniteQuery(() => ({
  queryKey: ['posts'],
  queryFn: async ({ pageParam }) => {
    const res = await fetch(`/api/posts?page=${pageParam}`);
    return res.json();
  },
  initialPageParam: 1,
  getNextPageParam: (lastPage) => lastPage.nextPage
}));

<Show when={query.hasNextPage()}>
  <Button onClick={() => query.fetchNextPage()}>Load more</Button>
</Show>
```

## Optimistic Updates
```ts
mutation.mutate(newData, {
  onMutate: async (newData) => {
    await queryClient.cancelQueries({ queryKey: ['todos'] });
    const prevData = queryClient.getQueryData(['todos']);
    queryClient.setQueryData(['todos'], (old) => [...old, newData]);
    return { prevData };
  },
  onError: (_err, _newData, context) => {
    queryClient.setQueryData(['todos'], context.prevData);
  }
});
```

## Dependent Queries
```ts
const query = createQuery(() => ({
  queryKey: ['user', userId()],
  queryFn: () => fetch(`/api/users/${userId()}`).then(r => r.json()),
  enabled: !!userId()  // Only run if userId is set
}));
```
