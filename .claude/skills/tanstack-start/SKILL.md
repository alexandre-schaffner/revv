---
name: tanstack-start
description: Full-stack framework with file-based routing, server functions, SSR/SSG, and loaders. Built on TanStack Router and Vinxi
when_to_use: When building full-stack SolidJS/React apps, need file-based routing with server functions, or want type-safe end-to-end development
---

# TanStack Start (v0.1.x)

Full-stack framework combining TanStack Router (client routing) with Vinxi (SSR/file handling) and server functions for seamless data loading and mutations. File-based routing. Type-safe RPC between client and server.

## Core Concepts

### File-Based Routing
- `routes/` directory with `route.ts`, `layout.ts`, `page.ts` files
- Nested routes via nested directories
- Route segments with `$` prefix: `$userId/route.ts`

### Server Functions
```ts
// server/api.ts
import { createServerFn } from '@tanstack/start';

export const getUser = createServerFn({ method: 'GET' })(async (id: number) => {
  return await db.user.findById(id);
});
```

### Loaders
```ts
export const Route = createRootRoute({
  loader: async () => {
    return { user: await getUser() };
  }
});
```

### Streaming & SSR
Built-in support for streaming data, concurrent rendering, error boundaries.

## Learn More

- API reference: [api-reference.md](api-reference.md)
- Examples: [examples.md](examples.md)
- Best practices: [best-practices.md](best-practices.md)
- Docs: https://tanstack.com/start
