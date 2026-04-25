# Kobalte API Reference

## Dialog
```tsx
<Dialog open={open()} onOpenChange={setOpen}>
  <Dialog.Trigger as="button">Open</Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content>
      <Dialog.CloseButton />
      <Dialog.Title>Title</Dialog.Title>
      <Dialog.Description>Description</Dialog.Description>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog>
```

## Select
```tsx
<Select options={items()} optionTextMatches={textMatches}>
  <Select.Trigger>
    <Select.Value />
    <Select.Icon />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content>
      <Select.Listbox>
        <For each={items()}>
          {(item) => (
            <Select.Option value={item.value}>
              {item.label}
            </Select.Option>
          )}
        </For>
      </Select.Listbox>
    </Select.Content>
  </Select.Portal>
</Select>
```

## Tabs
```tsx
<Tabs value={selected()} onChange={setSelected}>
  <Tabs.List>
    <Tabs.Trigger value="tab1">Tab 1</Tabs.Trigger>
    <Tabs.Trigger value="tab2">Tab 2</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="tab1">Content 1</Tabs.Content>
  <Tabs.Content value="tab2">Content 2</Tabs.Content>
</Tabs>
```

## Accordion
```tsx
<Accordion>
  <Accordion.Item value="item1">
    <Accordion.Trigger>Item 1</Accordion.Trigger>
    <Accordion.Content>Content 1</Accordion.Content>
  </Accordion.Item>
</Accordion>
```

## Popover
```tsx
<Popover>
  <Popover.Trigger>Open</Popover.Trigger>
  <Popover.Portal>
    <Popover.Content>Content</Popover.Content>
  </Popover.Portal>
</Popover>
```

## Tooltip
```tsx
<Tooltip>
  <Tooltip.Trigger>Hover me</Tooltip.Trigger>
  <Tooltip.Content>Tooltip text</Tooltip.Content>
</Tooltip>
```

## Checkbox
```tsx
<Checkbox checked={checked()} onChange={setChecked}>
  <Checkbox.Input />
  <Checkbox.Control />
  <Checkbox.Label>Option</Checkbox.Label>
</Checkbox>
```

## Radio
```tsx
<RadioGroup value={selected()} onChange={setSelected}>
  <For each={options()}>
    {(opt) => (
      <Radio value={opt.value}>
        <Radio.Input />
        <Radio.Control />
        <Radio.Label>{opt.label}</Radio.Label>
      </Radio>
    )}
  </For>
</RadioGroup>
```

## Textfield
```tsx
<TextField value={value()} onChange={setValue}>
  <Textfield.Label>Name</Textfield.Label>
  <Textfield.Input />
  <Textfield.ErrorMessage>{error()}</Textfield.ErrorMessage>
</TextField>
```

All components support `as` prop for polymorphism and data attributes for styling.
