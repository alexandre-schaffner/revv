# Better Auth API

## Server Setup
```ts
betterAuth(options)
```
Options: database, secret, socialProviders, plugins, session, emailAndPassword

## OAuth Providers
- github, google, discord, twitch, linkedin, microsoft, etc.

## Plugins
- twoFactor: 2FA support
- organization: Teams/orgs
- passkey: Passwordless auth
- admin: Admin dashboard
- magicLink: Passwordless email links
- anonymous: Anonymous sessions
- customSessions: Custom session logic

## Client
```ts
import { createAuthClient } from 'better-auth/client'

const client = createAuthClient()
const session = await client.getSession()
const { data } = await client.signIn.social({ provider: 'github' })
```
