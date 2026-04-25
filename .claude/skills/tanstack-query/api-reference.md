# TanStack Query v5 -- API Reference

## useQuery (React) / createQuery (Solid)

```typescript
import { useQuery } from '@tanstack/react-query'

const result = useQuery({
  // --- Required ---
  queryKey: unknown[],
  queryFn: (context: QueryFunctionContext) => Promise<TData>,

  // --- Data Management ---
  initialData: TData | () => TData,
  initialDataUpdatedAt: number | (() => number | undefined),
  placeholderData: TData | (previousValue, previousQuery) => TData,
  select: (data: TData) => unknown,
  staleTime: number | 'static' | ((query) => number | 'static'),  // default: 0

  // --- Cache & GC ---
  gcTime: number | Infinity,  // default: 5 min (client), Infinity (SSR)
  structuralSharing: boolean | ((oldData, newData) => TData),  // default: true

  // --- Retry ---
  retry: boolean | number | ((failureCount, error) => boolean),  // default: 3
  retryOnMount: boolean,
  retryDelay: number | ((retryAttempt, error) => number),

  // --- Refetching ---
  refetchInterval: number | false | ((query) => number | false),
  refetchIntervalInBackground: boolean,
  refetchOnMount: boolean | 'always',      // default: true
  refetchOnWindowFocus: boolean | 'always', // default: true
  refetchOnReconnect: boolean | 'always',   // default: true

  // --- Execution Control ---
  enabled: boolean | ((query) => boolean),
  networkMode: 'online' | 'always' | 'offlineFirst',  // default: 'online'
  throwOnError: boolean | ((error, query) => boolean),

  // --- Optimization ---
  notifyOnChangeProps: string[] | 'all',
  meta: Record<string, unknown>,
})
```

### Return Values

```typescript
interface UseQueryResult<TData, TError> {
  // Status
  status: 'pending' | 'error' | 'success'
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  isLoadingError: boolean
  isRefetchError: boolean

  // Data
  data: TData | undefined
  dataUpdatedAt: number
  error: TError | null
  errorUpdatedAt: number
  isPlaceholderData: boolean

  // Fetch status
  fetchStatus: 'fetching' | 'paused' | 'idle'
  isFetching: boolean
  isLoading: boolean        // isPending && isFetching (first load)
  isRefetching: boolean     // isFetching && !isPending
  isPaused: boolean

  // Freshness
  isStale: boolean
  isFetched: boolean
  isFetchedAfterMount: boolean

  // Actions
  refetch: (options?) => Promise<UseQueryResult>
  promise: Promise<TData>  // stable promise for React.use()
}
```

### Solid Adapter

```typescript
import { createQuery } from '@tanstack/solid-query'

// Options are wrapped in a getter function for reactivity
const query = createQuery(() => ({
  queryKey: ['todos', filter()],
  queryFn: fetchTodos,
}))
// Access query.data etc. in reactive context only
```

---

## useMutation (React) / createMutation (Solid)

```typescript
import { useMutation } from '@tanstack/react-query'

const mutation = useMutation({
  // --- Core ---
  mutationFn: (variables: TVariables) => Promise<TData>,
  mutationKey: unknown[],

  // --- Lifecycle ---
  onMutate: (variables, context) => Promise<TContext> | TContext,
  onSuccess: (data, variables, onMutateResult, context) => void | Promise,
  onError: (error, variables, onMutateResult, context) => void | Promise,
  onSettled: (data, error, variables, onMutateResult, context) => void | Promise,

  // --- Retry ---
  retry: boolean | number | ((failureCount, error) => boolean),
  retryDelay: number | ((retryAttempt, error) => number),

  // --- Other ---
  gcTime: number,
  networkMode: 'online' | 'always' | 'offlineFirst',
  scope: { id: string },  // serial execution for mutations with same scope
  throwOnError: boolean | ((error) => boolean),
  meta: Record<string, unknown>,
})
```

### Return Values

```typescript
interface UseMutationResult<TData, TError, TVariables, TContext> {
  status: 'idle' | 'pending' | 'error' | 'success'
  isIdle: boolean
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  isPaused: boolean

  data: TData | undefined
  error: TError | null
  variables: TVariables | undefined
  failureCount: number
  failureReason: TError | null
  submittedAt: number

  mutate: (variables, options?) => void
  mutateAsync: (variables, options?) => Promise<TData>
  reset: () => void
}
```

### Additional Callbacks on mutate()

```typescript
mutation.mutate(variables, {
  onSuccess: (data, variables, onMutateResult, context) => {},
  onError: (error, variables, onMutateResult, context) => {},
  onSettled: (data, error, variables, onMutateResult, context) => {},
})
```

Hook-level callbacks execute first, then mutate()-level callbacks.

---

## useInfiniteQuery (React) / createInfiniteQuery (Solid)

Extends useQuery with pagination. Additional options:

```typescript
const result = useInfiniteQuery({
  queryKey: ['projects'],
  queryFn: ({ pageParam }) => fetchProjects(pageParam),

  // --- Required ---
  initialPageParam: TPageParam,
  getNextPageParam: (lastPage, allPages, lastPageParam, allPageParams) =>
    TPageParam | undefined | null,

  // --- Optional ---
  getPreviousPageParam: (firstPage, allPages, firstPageParam, allPageParams) =>
    TPageParam | undefined | null,
  maxPages: number,  // limit stored pages for memory

  // All useQuery options also apply
})
```

### Additional Return Values

```typescript
{
  data: {
    pages: TData[]        // array of all fetched pages
    pageParams: TPageParam[]
  }
  fetchNextPage: (options?) => Promise
  fetchPreviousPage: (options?) => Promise
  hasNextPage: boolean
  hasPreviousPage: boolean
  isFetchingNextPage: boolean
  isFetchingPreviousPage: boolean
  isFetchNextPageError: boolean
  isFetchPreviousPageError: boolean
}
```

---

## useSuspenseQuery

Like useQuery but integrates with React Suspense. Key differences:
- `data` is **guaranteed defined** (never undefined)
- No `enabled`, `placeholderData`, or `throwOnError` options
- `status` is only `'success'` or `'error'`
- Must be used inside `<Suspense>` and `<ErrorBoundary>`

```typescript
import { useSuspenseQuery } from '@tanstack/react-query'

function Todos() {
  const { data } = useSuspenseQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
  })
  // data is always defined here
  return <ul>{data.map(t => <li key={t.id}>{t.text}</li>)}</ul>
}
```

Also: `useSuspenseInfiniteQuery`, `useSuspenseQueries`.

---

## useQueries

Run multiple queries in parallel with dynamic count:

```typescript
const results = useQueries({
  queries: users.map(user => ({
    queryKey: ['user', user.id],
    queryFn: () => fetchUser(user.id),
  })),
})
// returns array of UseQueryResult
```

---

## useIsFetching / useMutationState

```typescript
// Count of all fetching queries
const isFetching = useIsFetching()
const isFetchingTodos = useIsFetching({ queryKey: ['todos'] })

// Access mutation state across components
const pendingVariables = useMutationState({
  filters: { mutationKey: ['addTodo'], status: 'pending' },
  select: (mutation) => mutation.state.variables,
})
```

---

## QueryClient

```typescript
import { QueryClient } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 3, gcTime: 5 * 60_000 },
    mutations: { retry: 1 },
  },
})
```

### Key Methods

```typescript
// Data access
queryClient.getQueryData(queryKey)           // sync, returns TData | undefined
queryClient.getQueryState(queryKey)          // sync, full state object
queryClient.getQueriesData(filters)          // sync, [key, data][]
queryClient.setQueryData(queryKey, updater)  // sync, immutable update
queryClient.setQueriesData(filters, updater) // sync, update multiple

// Fetching
queryClient.fetchQuery(options)              // async, returns data or throws
queryClient.prefetchQuery(options)           // async, void, no throw
queryClient.ensureQueryData(options)         // async, cache-first fetch
queryClient.fetchInfiniteQuery(options)
queryClient.prefetchInfiniteQuery(options)

// Cache management
queryClient.invalidateQueries(filters)       // mark stale + refetch active
queryClient.refetchQueries(filters)          // force refetch matching
queryClient.cancelQueries(filters)           // cancel outgoing requests
queryClient.removeQueries(filters)           // remove from cache
queryClient.resetQueries(filters)            // reset to initial state

// Status
queryClient.isFetching(filters)              // number of fetching queries
queryClient.isMutating(filters)              // number of fetching mutations

// Defaults
queryClient.setQueryDefaults(queryKey, options)
queryClient.setMutationDefaults(mutationKey, options)

// Lifecycle
queryClient.clear()                          // remove all cache entries
queryClient.resumePausedMutations()          // resume offline mutations
```

### invalidateQueries Options

```typescript
queryClient.invalidateQueries({
  queryKey: ['todos'],
  exact: false,            // prefix match (default)
  refetchType: 'active',  // 'active' | 'inactive' | 'all' | 'none'
  cancelRefetch: true,     // cancel in-flight before refetch
})
```

---

## queryOptions

Type-safe query configuration factory:

```typescript
import { queryOptions } from '@tanstack/react-query'

const todosOptions = queryOptions({
  queryKey: ['todos'] as const,
  queryFn: fetchTodos,
  staleTime: 5 * 60_000,
})

// Reusable everywhere with type inference
useQuery(todosOptions)
useSuspenseQuery(todosOptions)
queryClient.prefetchQuery(todosOptions)
queryClient.invalidateQueries({ queryKey: todosOptions.queryKey })
queryClient.getQueryData(todosOptions.queryKey)
```

---

## QueryClientProvider

```typescript
import { QueryClientProvider } from '@tanstack/react-query'

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  )
}
```

---

## HydrationBoundary

For SSR hydration:

```typescript
import { dehydrate, HydrationBoundary } from '@tanstack/react-query'

// Server
const dehydratedState = dehydrate(queryClient)

// Client
<HydrationBoundary state={dehydratedState}>
  <App />
</HydrationBoundary>
```

---

## QueryErrorResetBoundary

Reset error state for Suspense error boundaries:

```typescript
import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { ErrorBoundary } from 'react-error-boundary'

<QueryErrorResetBoundary>
  {({ reset }) => (
    <ErrorBoundary onReset={reset} fallbackRender={({ resetErrorBoundary }) => (
      <button onClick={resetErrorBoundary}>Retry</button>
    )}>
      <Suspense fallback={<Loading />}>
        <MyComponent />
      </Suspense>
    </ErrorBoundary>
  )}
</QueryErrorResetBoundary>
```

---

## Query Filters

Used by invalidateQueries, refetchQueries, cancelQueries, removeQueries, etc.:

```typescript
interface QueryFilters {
  queryKey?: QueryKey     // prefix match by default
  exact?: boolean         // exact key match
  type?: 'active' | 'inactive' | 'all'
  stale?: boolean
  fetchStatus?: FetchStatus
  predicate?: (query: Query) => boolean
}
```
