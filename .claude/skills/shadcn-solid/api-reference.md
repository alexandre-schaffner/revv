# shadcn-solid Components

## Button
```tsx
import { Button } from '@/components/ui/button';

<Button>Click me</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="outline">Outline</Button>
<Button size="sm">Small</Button>
<Button disabled>Disabled</Button>
```
Props: `variant`, `size`, `disabled`, `onclick`

## Input
```tsx
<Input type="text" placeholder="Enter text" value={val()} onChange={(e) => setVal(e.target.value)} />
<Input type="email" />
<Input type="password" />
<Input disabled />
```

## Select
```tsx
<Select options={items()} optionTextMatches={textMatches}>
  <Select.Trigger><Select.Value /></Select.Trigger>
  <Select.Portal>
    <Select.Content>
      <Select.Listbox>
        <For each={items()}>{(item) => <Select.Option value={item}>{item}</Select.Option>}</For>
      </Select.Listbox>
    </Select.Content>
  </Select.Portal>
</Select>
```

## Checkbox
```tsx
<Checkbox checked={checked()} onChange={setChecked} label="Option" />
<Checkbox disabled />
```

## Dialog
```tsx
<Dialog>
  <Dialog.Trigger>Open</Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Title>Title</Dialog.Title>
    <Dialog.Description>Description</Dialog.Description>
  </Dialog.Content>
</Dialog>
```

## Card
```tsx
<Card>
  <Card.Header>
    <Card.Title>Title</Card.Title>
  </Card.Header>
  <Card.Content>Content</Card.Content>
  <Card.Footer>Footer</Card.Footer>
</Card>
```

## Table
```tsx
<Table>
  <Table.Header>
    <Table.Row>
      <Table.Head>Header</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    <Table.Row>
      <Table.Cell>Data</Table.Cell>
    </Table.Row>
  </Table.Body>
</Table>
```

## Toast
```tsx
import { createToast } from '@/components/ui/toast';

createToast({
  title: 'Success',
  description: 'Operation completed',
  variant: 'success'
});
```

All components support `class` prop for additional styling.
