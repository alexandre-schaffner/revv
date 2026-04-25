# Better Auth Best Practices

## Callback URL Setup

For GitHub OAuth:
```
http://localhost:45678/api/auth/callback/github
https://yourdomain.com/api/auth/callback/github
```

## Session Strategy

- Use cookies (httpOnly) for web apps
- Use Bearer tokens for mobile/SPA
- Configure CSRF protection

## Protect Routes

```ts
// Elysia middleware
.derive(async ({ request }) => {
  const session = await auth.api.getSession(request)
  if (!session) throw new Error('Unauthorized')
  return { user: session.user }
})
```

## Database Schema

Better-Auth auto-creates tables or use existing schema:
```ts
const tables = {
  user: 'users',
  account: 'accounts',
  session: 'sessions',
  verification: 'verifications'
}
```

## Plugin Ordering

Load plugins in logical order:
1. sessionPlugin (or session config)
2. twoFactor, passkey, magicLink
3. organization, admin
4. customSessions (last)

## Testing

Mock auth with test client:
```ts
const { data: session } = await auth.api.signIn({
  email: 'test@example.com',
  password: 'password123'
})
```
