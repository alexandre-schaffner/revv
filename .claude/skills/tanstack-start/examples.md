# TanStack Start Examples

## Basic Route
```ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/users')({
  component: Users
})

function Users() { return <div>Users</div> }
```

## With Loader
```ts
export const Route = createFileRoute('/user/$userId')({
  loader: async ({ params }) => {
    return { user: await getUser(params.userId) }
  },
  component: User
})

function User() {
  const data = Route.useLoaderData()
  return <div>{data.user.name}</div>
}
```

## Server Function
```ts
import { createServerFn } from '@tanstack/start'

export const createTodo = createServerFn({ method: 'POST' })(
  async (title: string) => {
    return await db.todos.create({ title })
  }
)

function CreateTodo() {
  const { mutate } = createMutation({
    mutationFn: createTodo
  })
  return <button onClick={() => mutate('New todo')}>Create</button>
}
```
