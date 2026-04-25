# TanStack Start Best Practices

## Folder Structure
```
routes/
  __root.tsx      # Root layout
  /users/
    route.tsx     # /users page
    /$userId/     # /users/:id
      route.tsx
```

## Type-Safe Server Functions
Keep RPC boundaries clear; validate on server.

## Error Boundaries
Use errorComponent per route for graceful error handling.

## Data Loading
- Use loaders for initial data
- Mutations for updates
- Server functions for RPCs
