# Better Auth Examples

## Drizzle + SQLite
```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '@/db'

const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  secret: process.env.BETTER_AUTH_SECRET,
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    }
  }
})
```

## Elysia Integration
```ts
import Elysia from 'elysia'
import { auth } from '@/auth'

new Elysia()
  .use(auth.handler)
  .listen(45678)
```

## SolidJS Client
```ts
import { createAuthClient } from 'better-auth/client'

const authClient = createAuthClient()

const [session, setSession] = createSignal(null)

onMount(async () => {
  const { data } = await authClient.getSession()
  setSession(data)
})

const signOut = () => authClient.signOut()
```
