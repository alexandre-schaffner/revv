# TanStack Start API

## Routes
```ts
createRootRoute(), createFileRoute()
- loader()
- component()
- errorComponent()
- notFoundComponent()
- beforeLoad()
```

## Server Functions
```ts
createServerFn({ method: 'GET' | 'POST' })
- RPC to server, type-safe
- Automatic serialization
```

## Search Params
```ts
createSearchParamsCache()
- Type-safe URL search params
- Validation via schema
```

## Actions
```ts
server$() - Execute code only on server
```
