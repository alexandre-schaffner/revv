# Kobalte Best Practices

## Use Data Attributes for Styling

```tsx
// Style selected, disabled, focused states with data attributes
<Select.Option 
  value="opt" 
  class="px-3 py-2 
    data-[disabled]:opacity-50 
    data-[highlighted]:bg-blue-500 
    data-[selected]:font-bold"
>
  Option
</Select.Option>
```

## Portal for Overlays

Always use `Portal` to render overlays outside the component tree:

```tsx
<Dialog.Portal>
  <Dialog.Overlay />
  <Dialog.Content>...</Dialog.Content>
</Dialog.Portal>
```

## Keyboard Navigation

Kobalte handles arrow keys, Tab, Enter, Escape automatically. Ensure:
- Select uses arrow keys to navigate options
- Popover closes on Escape
- Dialog focuses trap on Tab

## Accessibility Checklist

- ✅ All interactive elements keyboard accessible
- ✅ ARIA roles/attributes included automatically
- ✅ Screen reader friendly labels
- ✅ Focus visible/trapped in modals
- ✅ Color not sole indicator (use icons/text)

## Polymorphic `as` Prop

```tsx
// Render trigger as <a> instead of <button>
<Dialog.Trigger as="a" href="#details">
  Details
</Dialog.Trigger>

// Or as custom component
<Select.Trigger as={CustomButton} />
```

## Styling Strategy

**Option 1: Tailwind (recommended)**
```tsx
<Dialog.Trigger class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
  Open
</Dialog.Trigger>
```

**Option 2: CSS Classes**
```css
.dialog-trigger {
  /* styles */
}
.dialog-trigger[data-disabled] {
  opacity: 0.5;
}
```

## Avoid Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forget Portal wrapper | Use Dialog.Portal / Popover.Portal |
| Hardcode focused state | Use data-[highlighted] attribute |
| Destroy/recreate on state change | Keep Dialog open/close controlled |
| Custom keyboard handling | Let component handle arrow keys, Tab, etc |
