---
name: better-auth
description: TypeScript authentication framework with OAuth, sessions, plugins, and database adapters. Works with any backend, any database
when_to_use: When building auth systems with GitHub/Google OAuth, need session management, 2FA support, or flexible database integration (Drizzle, Prisma, etc)
---

# Better Auth (v0.13.x)

Full-featured authentication framework. Session-based or JWT. Plugins for 2FA, organizations, passkeys, magic links. Database adapters for Drizzle, Prisma, Kysely, etc. Works with Elysia, Express, Hono, Nitro.

## Core Setup

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import db from '@/lib/db'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'sqlite'
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    }
  }
})
```

## Plugins

```ts
import { twoFactor } from 'better-auth/plugins'
import { organization } from 'better-auth/plugins'
import { passkey } from 'better-auth/plugins'
import { admin } from 'better-auth/plugins'

betterAuth({
  plugins: [
    twoFactor(),
    organization(),
    passkey(),
    admin()
  ]
})
```
