# shadcn-solid Best Practices

## Copy & Customize

Components are meant to be copied and modified:

```tsx
// Copy from docs, customize for your needs
<Button 
  variant="primary"
  class="custom-styling"
>
  Click me
</Button>
```

## Dark Mode

Built-in dark mode via `dark:` Tailwind classes:

```tsx
<div class="bg-white dark:bg-slate-900 text-black dark:text-white">
  Content
</div>
```

## Color Scheme

Customize in your Tailwind config or override component colors:

```tsx
<Button class="bg-purple-500 hover:bg-purple-600">
  Custom color
</Button>
```

## Form Validation

Use with TanStack Form for type-safe validation:

```tsx
const form = useForm({
  defaultValues: { email: '' },
  onSubmit: async ({ value }) => { /* submit */ }
});

<form.Field name="email">
  {(field) => (
    <div>
      <Label>Email</Label>
      <Input value={field.state.value} onChange={field.handleChange} />
      {field.state.meta.errors && <span class="text-red-500">{field.state.meta.errors[0]}</span>}
    </div>
  )}
</form.Field>
```

## Composition

Combine components for complex UIs:

```tsx
<Card>
  <Card.Header>
    <Card.Title>Settings</Card.Title>
  </Card.Header>
  <Card.Content>
    <form class="space-y-6">
      <div>
        <Label>Theme</Label>
        <Select>...</Select>
      </div>
    </form>
  </Card.Content>
</Card>
```

## Accessible Forms

Use Label with Input via `htmlFor`:

```tsx
<div>
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" />
</div>
```

## Variants

Each component has variants. Use consistently:

```tsx
<Button variant="primary">Submit</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost">Learn more</Button>
<Button variant="outline">Details</Button>
```
