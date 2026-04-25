# Kobalte Examples

## Modal Dialog
```tsx
import { Dialog } from '@kobalte/core/dialog';
import { createSignal } from 'solid-js';

export function Modal() {
  const [open, setOpen] = createSignal(false);

  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <Dialog.Trigger class="px-4 py-2 bg-blue-500 text-white rounded">
        Open Modal
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 bg-black/30" />
        <Dialog.Content class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6">
          <Dialog.Title>Confirm</Dialog.Title>
          <Dialog.Description>Are you sure?</Dialog.Description>
          <div class="flex gap-2 mt-4">
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button class="bg-blue-500 text-white px-4 py-2 rounded">OK</button>
          </div>
          <Dialog.CloseButton class="absolute top-2 right-2">×</Dialog.CloseButton>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
```

## Styled Select with Tailwind
```tsx
import { Select } from '@kobalte/core/select';

<Select options={['Opt1', 'Opt2', 'Opt3']}>
  <Select.Trigger class="flex items-center justify-between border rounded px-3 py-2">
    <Select.Value />
    <Select.Icon />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="border rounded shadow-lg bg-white">
      <Select.Listbox class="p-2">
        <For each={['Opt1', 'Opt2', 'Opt3']}>
          {(opt) => (
            <Select.Option value={opt} class="px-3 py-2 rounded hover:bg-gray-100 data-[highlighted]:bg-blue-500">
              {opt}
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
<Tabs value={tab()} onChange={setTab} class="w-full">
  <Tabs.List class="flex border-b">
    <Tabs.Trigger value="profile" class="px-4 py-2 data-[selected]:border-b-2 data-[selected]:border-blue-500">Profile</Tabs.Trigger>
    <Tabs.Trigger value="settings" class="px-4 py-2 data-[selected]:border-b-2 data-[selected]:border-blue-500">Settings</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="profile" class="p-4">Profile content</Tabs.Content>
  <Tabs.Content value="settings" class="p-4">Settings content</Tabs.Content>
</Tabs>
```

## Accessible Form
```tsx
import { Textfield } from '@kobalte/core/textfield';

<Textfield value={email()} onChange={setEmail} validationState={emailError() ? 'invalid' : 'valid'}>
  <Textfield.Label class="block font-semibold mb-1">Email</Textfield.Label>
  <Textfield.Input type="email" class="w-full border rounded px-3 py-2 data-[invalid]:border-red-500" />
  <Textfield.ErrorMessage class="text-red-500 text-sm mt-1">
    {emailError()}
  </Textfield.ErrorMessage>
</Textfield>
```
