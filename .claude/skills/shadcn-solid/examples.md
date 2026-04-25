# shadcn-solid Examples

## Login Form
```tsx
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { createSignal } from 'solid-js';

export function LoginForm() {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    setLoading(true);
    // Submit logic
    setLoading(false);
  };

  return (
    <Card class="w-full max-w-md mx-auto">
      <Card.Header>
        <Card.Title>Sign In</Card.Title>
      </Card.Header>
      <Card.Content>
        <form onSubmit={handleSubmit} class="space-y-4">
          <Input
            type="email"
            placeholder="Email"
            value={email()}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password()}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" class="w-full" disabled={loading()}>
            {loading() ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
```

## Data Table
```tsx
import { Table } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { For } from 'solid-js';

<Table>
  <Table.Header>
    <Table.Row>
      <Table.Head><Checkbox /></Table.Head>
      <Table.Head>Name</Table.Head>
      <Table.Head>Email</Table.Head>
      <Table.Head>Role</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    <For each={users()}>
      {(user) => (
        <Table.Row>
          <Table.Cell><Checkbox /></Table.Cell>
          <Table.Cell>{user.name}</Table.Cell>
          <Table.Cell>{user.email}</Table.Cell>
          <Table.Cell>{user.role}</Table.Cell>
        </Table.Row>
      )}
    </For>
  </Table.Body>
</Table>
```

## Modal with Form
```tsx
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

<Dialog open={open()} onOpenChange={setOpen}>
  <Dialog.Trigger>Create New</Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Title>Create Item</Dialog.Title>
    <form class="space-y-4">
      <Input placeholder="Item name" />
      <Input placeholder="Description" />
      <div class="flex gap-2 justify-end">
        <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
        <Button>Create</Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog>
```
