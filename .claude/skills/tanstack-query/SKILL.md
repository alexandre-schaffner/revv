---
name: tanstack-query
description: Async state management and server-state caching for React, Svelte, Solid, Vue. Handles queries, mutations, caching, invalidation, and prefetching
when_to_use: When fetching/caching server data, managing async state, handling mutations, or needing advanced features like infinite queries and optimistic updates
---

# TanStack Query (v5.x)

Asynchronous state management library. Manages queries (fetch, cache, sync), mutations (create/update/delete), and provides fine-grained control over cache invalidation, refetching, and data synchronization.

## Core Concepts

### Queries

Fetch and cache data from a server. Identified by unique query keys.

```ts
const query = createQuery(() => ({
  queryKey: ['users', userId()],
  queryFn: async () => fetch(`/api/users/${userId()}`).then(r => r.json()),
  staleTime: 5 * 60 * 1000, // 5 minutes
}));

query.data        // Result
query.isLoading   // Loading state
query.error       // Error, if any
query.refetch()   // Manual refetch
```

### Query Keys

Unique identifiers for caching and invalidation:

```ts
['users']           // All users
['users', id]       // Specific user
['users', { status: 'active' }] // Users with filter
['todos', 'list']   // Todo list
```

### Mutations

Create/update/delete data:

```ts
const mutation = createMutation(() => ({
  mutationFn: async (newUser) => fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(newUser)
  }).then(r => r.json()),
  onSuccess: (data) => {
    queryClient.invalidateQueries({ queryKey: ['users'] });
  }
}));

mutation.mutate({ name: 'Alice' });
mutation.isPending   // Loading
mutation.isError     // Error
mutation.data        // Result
```

### Stale vs Cache Time

- **Stale time:** How long data is fresh (no refetch needed)
- **Cache time:** How long unused data stays in memory

```ts
staleTime: 5 * 60 * 1000,    // 5 min: data is fresh for 5 min
gcTime: 10 * 60 * 1000,      // 10 min: unused data removed after 10 min
```

## Learn More

- Full API: [api-reference.md](api-reference.md)
- Examples: [examples.md](examples.md)
- Best practices: [best-practices.md](best-practices.md)
- Docs: https://tanstack.com/query
