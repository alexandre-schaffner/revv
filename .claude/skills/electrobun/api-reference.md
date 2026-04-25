# Electrobun API Reference

Documented version: v1.x (npm `electrobun` ~1.12.x).

All main-process APIs are imported from `electrobun/bun`. Renderer APIs from `electrobun/view`.

---

## electrobun.config.ts (Build Configuration)

The root configuration file controls app metadata, build settings, and release options.

```typescript
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: string,              // Display name
    identifier: string,        // Reverse-DNS bundle ID (e.g. "dev.my.app")
    version: string,           // Semver (e.g. "1.0.0")
    urlSchemes?: string[],     // Deep-link protocols (e.g. ["myapp"])
  },

  runtime: {
    exitOnLastWindowClosed?: boolean,  // Default: true
  },

  build: {
    bun: {
      entrypoint: string,      // Main process entry (e.g. "src/bun/index.ts")
    },
    views: {
      [name: string]: {
        entrypoint: string,    // Renderer entry (e.g. "src/views/main/index.html")
        minify?: boolean,
      },
    },
    copy?: Record<string, string>,     // Static files: { "src/assets": "assets" }
    useAsar?: boolean,                 // Pack resources into ASAR archive
    cefVersion?: string,               // Override CEF version
    bunVersion?: string,               // Override Bun version
    mac?: {
      bundleCEF?: boolean,
      bundleWGPU?: boolean,
      codesign?: boolean,
      notarize?: boolean,
      chromiumFlags?: string[],
      icon?: string,                   // Path to .icns
    },
    win?: {
      bundleCEF?: boolean,
      bundleWGPU?: boolean,
      icon?: string,                   // Path to .ico
    },
    linux?: {
      bundleCEF?: boolean,
      bundleWGPU?: boolean,
      icon?: string,                   // Path to .png
    },
  },

  release?: {
    baseUrl?: string,          // Update artifact host URL
    generatePatch?: boolean,   // Generate bsdiff patches
  },
} satisfies ElectrobunConfig;
```

---

## BrowserWindow

Creates a native OS window. Each window automatically creates a primary BrowserView.

### Constructor

```typescript
import { BrowserWindow } from "electrobun/bun";

new BrowserWindow<T>(options: {
  title?: string,                    // Default: "Electrobun"
  frame?: { x: number, y: number, width: number, height: number },
                                     // Default: { 0, 0, 800, 600 }
  url?: string | null,               // Initial URL (supports views://)
  html?: string | null,              // Initial HTML content (mutually exclusive with url)
  preload?: string | null,           // Preload script URL (supports data: URLs)
  renderer?: "native" | "cef",      // Rendering engine
  rpc?: T,                           // RPC schema (from BrowserView.defineRPC)
  titleBarStyle?: "default" | "hidden" | "hiddenInset",
  transparent?: boolean,             // Default: false
  navigationRules?: string | null,   // JSON array of URL glob patterns
  sandbox?: boolean,                 // Default: false (disables RPC when true)
  styleMask?: {                      // macOS-specific window style flags
    Titled?: boolean,
    Closable?: boolean,
    Miniaturizable?: boolean,
    Resizable?: boolean,
    FullSizeContentView?: boolean,
  },
})
```

**titleBarStyle values:**
- `"default"` -- Standard OS title bar with native controls
- `"hidden"` -- No title bar; forces `Titled: false, FullSizeContentView: true`
- `"hiddenInset"` -- Transparent title bar with inset traffic lights; forces `Titled: true, FullSizeContentView: true`

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | `number` | Unique window identifier |
| `webviewId` | `number` | Attached webview ID |
| `webview` | `BrowserView` | Primary webview instance (getter) |
| `frame` | `{x, y, width, height}` | Current window frame |

### Methods

**Window control:**

| Method | Signature | Description |
|---|---|---|
| `setTitle` | `(title: string) => void` | Update title bar text |
| `close` | `() => void` | Close window and trigger cleanup |
| `focus` | `() => void` | Bring to front and focus |
| `show` | `() => void` | Show window (alias for focus) |
| `minimize` | `() => void` | Minimize to dock/taskbar |
| `unminimize` | `() => void` | Restore from minimized |
| `maximize` | `() => void` | Maximize to fill screen |
| `unmaximize` | `() => void` | Restore from maximized |

**Position and size:**

| Method | Signature | Description |
|---|---|---|
| `setPosition` | `(x: number, y: number) => void` | Move window |
| `setSize` | `(width: number, height: number) => void` | Resize window |
| `setFrame` | `(x, y, width, height: number) => void` | Set position + size atomically |
| `getPosition` | `() => {x, y}` | Current screen coordinates |
| `getSize` | `() => {width, height}` | Current dimensions |
| `getFrame` | `() => {x, y, width, height}` | Full position and size |

**Window state:**

| Method | Signature | Description |
|---|---|---|
| `setFullScreen` | `(fullScreen: boolean) => void` | Enter/exit fullscreen |
| `isFullScreen` | `() => boolean` | Fullscreen status |
| `setAlwaysOnTop` | `(alwaysOnTop: boolean) => void` | Pin above other windows |
| `isAlwaysOnTop` | `() => boolean` | Always-on-top status |
| `isMinimized` | `() => boolean` | Minimized status |
| `isMaximized` | `() => boolean` | Maximized status |

**Static:**

| Method | Signature | Description |
|---|---|---|
| `BrowserWindow.getById` | `(id: number) => BrowserWindow \| undefined` | Retrieve by ID |

### Events

Register with `window.on(eventName, handler)`. Window-scoped handlers fire before global handlers.

| Event | Data | Description |
|---|---|---|
| `"close"` | `{id}` | Window closing |
| `"focus"` | `{id}` | Window gained focus |
| `"blur"` | `{id}` | Window lost focus |
| `"resize"` | `{id, width, height}` | Window resized |
| `"move"` | `{id, x, y}` | Window moved |

---

## BrowserView

Manages a webview instance within a window. Automatically created by BrowserWindow; can also be instantiated manually or via `<electrobun-webview>` tags.

### Constructor

```typescript
import { BrowserView } from "electrobun/bun";

new BrowserView<T>({
  id?: number,
  windowId: number,
  url?: string,
  html?: string,
  preload?: string,
  renderer?: "native" | "cef",
  rpc?: T,
  navigationRules?: string,
  sandbox?: boolean,
  partition?: string,
  x?: number,
  y?: number,
  width?: number,
  height?: number,
})
```

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | `number` | Unique webview identifier |
| `windowId` | `number` | Parent window reference |
| `rpc` | `T` | Type-safe RPC configuration |
| `partition` | `string` | Storage partition |
| `sandbox` | `boolean` | Security sandbox mode |
| `navigationRules` | `string` | JSON glob patterns for URL filtering |

### Navigation Methods

| Method | Signature | Description |
|---|---|---|
| `loadURL` | `(url: string) => void` | Navigate to URL |
| `loadHTML` | `(html: string) => void` | Load raw HTML |
| `reload` | `() => void` | Refresh page |
| `goBack` | `() => void` | Navigate backward |
| `goForward` | `() => void` | Navigate forward |
| `stop` | `() => void` | Stop loading |

### JavaScript Execution

```typescript
evaluateJavascript(script: string): Promise<any>
```

Executes JS in the webview context and returns the result.

### Other Methods

| Method | Signature | Description |
|---|---|---|
| `updatePreloadScript` | `(script: string) => void` | Inject custom preload code |
| `findInPage` | `(text: string, options?) => void` | Page-level text search |
| `stopFindInPage` | `() => void` | Stop text search |
| `setFrame` | `(x, y, width, height) => void` | Reposition webview |
| `setSize` | `(width, height) => void` | Resize webview |
| `show` | `() => void` | Show webview |
| `hide` | `() => void` | Hide webview |
| `close` | `() => void` | Destroy webview |
| `getTitle` | `() => string` | Current page title |
| `getURL` | `() => string` | Current URL |
| `print` | `() => void` | Trigger print dialog |

### Webview Events

| Event | Description |
|---|---|
| `"navigate"` | URL navigation occurred |
| `"loadEnd"` | Page finished loading |
| `"dom-ready"` | DOM loaded, scripts can execute |
| `"findInPageResults"` | Find-in-page results |
| `"download-started"` | File download began |
| `"download-progress"` | Download progress update |
| `"download-completed"` | Download finished |
| `"crash"` | Webview process crashed |

---

## RPC (Remote Procedure Call)

Typed bidirectional communication between Bun main process and webview renderer. Transport: encrypted WebSocket (AES-256-GCM, per-webview 32-byte key). Server on random port 50000-65535. Max message: 500 MB.

### Schema Definition

Place in a shared file importable from both sides:

```typescript
import type { ElectrobunRPCSchema } from "electrobun";

export type MyAppRPC = ElectrobunRPCSchema<{
  bun: {
    requests: {
      readFile: (params: { path: string }) => Promise<string>;
      getConfig: () => Promise<Record<string, string>>;
    };
    messages: {
      log: (params: { level: string; msg: string }) => void;
    };
  };
  webview: {
    requests: {
      getTitle: () => Promise<string>;
      getFormData: (params: { formId: string }) => Promise<Record<string, string>>;
    };
    messages: {
      notify: (params: { msg: string }) => void;
    };
  };
}>;
```

- `bun` key: handlers that **execute in** the Bun process, **called from** the webview
- `webview` key: handlers that **execute in** the webview, **called from** Bun
- `requests`: return `Promise<T>`, support timeout, propagate errors
- `messages`: fire-and-forget, return `void`, no timeout

### Bun Side Implementation

```typescript
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { MyAppRPC } from "../shared/rpc-types";

const rpc = BrowserView.defineRPC<MyAppRPC>({
  maxRequestTime: 5000,  // ms timeout for requests
  handlers: {
    requests: {
      async readFile({ path }) {
        return await Bun.file(path).text();
      },
      async getConfig() {
        return { theme: "dark" };
      },
    },
    messages: {
      log({ level, msg }) {
        console.log(`[${level}] ${msg}`);
      },
    },
  },
});

const win = new BrowserWindow({
  rpc,
  url: "views://main/index.html",
});

// Call webview-side handlers:
const title = await rpc.request.getTitle();
rpc.message.notify({ msg: "Hello from Bun" });
```

### Webview Side Implementation

```typescript
import { Electroview } from "electrobun/view";
import type { MyAppRPC } from "../shared/rpc-types";

const rpc = Electroview.defineRPC<MyAppRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      async getTitle() {
        return document.title;
      },
      async getFormData({ formId }) {
        const form = document.getElementById(formId) as HTMLFormElement;
        return Object.fromEntries(new FormData(form));
      },
    },
    messages: {
      notify({ msg }) {
        console.log("From Bun:", msg);
      },
    },
  },
});

const view = new Electroview({ rpc });

// Call bun-side handlers:
const content = await rpc.request.readFile({ path: "/etc/hosts" });
rpc.message.log({ level: "info", msg: "Renderer ready" });
```

---

## ApplicationMenu

Static class for the app's main menu bar (macOS top bar, Windows/Linux title bar area).

```typescript
import { ApplicationMenu } from "electrobun/bun";

ApplicationMenu.setMenu([
  {
    label: "File",
    submenu: [
      { label: "New Window", action: "new-window", accelerator: "n" },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { label: "Undo", role: "undo" },
      { label: "Redo", role: "redo" },
      { type: "separator" },
      { label: "Cut", role: "cut" },
      { label: "Copy", role: "copy" },
      { label: "Paste", role: "paste" },
      { label: "Select All", role: "selectAll" },
    ],
  },
]);
```

### MenuItemConfig

All menu APIs (ApplicationMenu, ContextMenu, Tray) share this format:

| Property | Type | Description |
|---|---|---|
| `type` | `"normal" \| "separator" \| "divider"` | Item type |
| `label` | `string` | Display text |
| `action` | `string` | Custom click identifier |
| `role` | `string` | Standard OS action (mutually exclusive with action) |
| `submenu` | `MenuItemConfig[]` | Nested items |
| `enabled` | `boolean` | Default: true |
| `checked` | `boolean` | Show checkmark |
| `hidden` | `boolean` | Hide item |
| `tooltip` | `string` | Hover text |
| `accelerator` | `string` | Keyboard shortcut (e.g. "q", "Z") |

### Supported Roles

`quit`, `hide`, `hideOthers`, `showAll`, `undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `delete`, `selectAll`, `startSpeaking`, `stopSpeaking`, `minimize`, `zoom`, `close`, `toggleFullScreen`, `enterFullScreen`, `exitFullScreen`

Role-based items use system-localized labels automatically.

### Handling Clicks

```typescript
import { Electrobun } from "electrobun/bun";

Electrobun.events.on("application-menu-clicked", (event) => {
  if (event.action === "new-window") {
    // handle action
  }
});
```

---

## ContextMenu

Static class for popup context menus.

```typescript
import { ContextMenu } from "electrobun/bun";

ContextMenu.showContextMenu([
  { label: "Cut", action: "cut" },
  { label: "Copy", action: "copy" },
  { label: "Paste", action: "paste" },
  { type: "separator" },
  {
    label: "More",
    submenu: [
      { label: "Option A", action: "opt-a" },
      { label: "Option B", action: "opt-b" },
    ],
  },
]);

Electrobun.events.on("context-menu-clicked", (event) => {
  console.log("Clicked:", event.action);
});
```

Context menus use the same MenuItemConfig but do NOT support `role` or `accelerator` properties.

---

## Tray (System Tray)

```typescript
import { Tray } from "electrobun/bun";

const tray = new Tray({
  title: "My App",                              // Text next to icon
  image: "views://assets/icon-template.png",    // Icon path
  template: true,                                // macOS: monochrome adaptive icon
  width: 16,                                     // Icon width (px)
  height: 16,                                    // Icon height (px)
});
```

### Tray Methods

| Method | Signature | Description |
|---|---|---|
| `setTitle` | `(title: string) => void` | Update title text |
| `setImage` | `(path: string) => void` | Update icon |
| `setMenu` | `(items: MenuItemConfig[]) => void` | Set context menu |
| `remove` | `() => void` | Remove from system tray |

### Tray Events

```typescript
tray.on("tray-clicked", (event) => {
  if (event.action === "") {
    // Tray icon itself was clicked (not a menu item)
    tray.setMenu([
      { label: "Show Window", action: "show" },
      { type: "separator" },
      { label: "Quit", action: "quit" },
    ]);
  } else {
    // A menu item was clicked
    console.log("Menu action:", event.action);
  }
});
```

**Linux limitation:** AppIndicator does not support tray icon click events; only menu item clicks work.

---

## Utils

Static utility methods for system integration.

### Clipboard

```typescript
import { Utils } from "electrobun/bun";

const text = await Utils.clipboard.readText();
await Utils.clipboard.writeText("Hello");
await Utils.clipboard.clear();
```

### File Dialogs

```typescript
const filePath = await Utils.openFileDialog({
  startingFolder?: string,
  allowedFileTypes?: string[],    // e.g. ["png", "jpg"]
  canChooseFiles?: boolean,
  canChooseDirectory?: boolean,
  allowsMultipleSelection?: boolean,
});
```

### File Operations

```typescript
await Utils.openFile(path);             // Open with default app
await Utils.showInFolder(path);         // Reveal in file manager
await Utils.trashFile(path);            // Move to trash
```

### Path Resolution

```typescript
Utils.paths.userData     // App data directory
Utils.paths.home         // User home
Utils.paths.desktop      // Desktop directory
Utils.paths.documents    // Documents directory
Utils.paths.downloads    // Downloads directory
Utils.paths.app          // App installation directory
```

Platform-specific `userData` locations:
- macOS: `~/Library/Application Support/{identifier}/`
- Windows: `%LOCALAPPDATA%\{identifier}\`
- Linux: `$XDG_DATA_HOME/{identifier}/` or `~/.local/share/{identifier}/`

### Notifications

```typescript
await Utils.showNotification({
  title: "Update Available",
  body: "Version 2.0 is ready to install.",
});
```

### Application Control

```typescript
Utils.quit();  // Fires before-quit event, then exits
```

---

## Screen

```typescript
import { Screen } from "electrobun/bun";

const displays = Screen.getAllDisplays();
const primary = Screen.getPrimaryDisplay();
const cursor = Screen.getCursorScreenPoint();  // { x, y }
```

---

## GlobalShortcut

```typescript
import { GlobalShortcut } from "electrobun/bun";

const registered = GlobalShortcut.register("Ctrl+Shift+I", () => {
  console.log("Shortcut triggered");
});

GlobalShortcut.isRegistered("Ctrl+Shift+I");  // true
GlobalShortcut.unregister("Ctrl+Shift+I");
GlobalShortcut.unregisterAll();
```

Accelerator format: `"Ctrl+X"`, `"Cmd+Option+I"`, `"Shift+Alt+J"`.

---

## Session

Per-partition cookie and storage management.

### Partitions

| Partition string | Behavior |
|---|---|
| `"persist:name"` | Persisted to disk; survives restarts |
| `"name"` (no prefix) | In-memory only; cleared on exit |

```typescript
import { Session } from "electrobun/bun";

const session = Session.fromPartition("persist:main");
const defaultSession = Session.defaultSession;
```

### Cookie Operations

```typescript
// Set
session.cookies.set({
  name: "auth-token",
  value: "abc123",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expirationDate: Math.floor(Date.now() / 1000) + 3600,
});

// Get all
const cookies = session.cookies.get();
// Get filtered
const filtered = session.cookies.get({ name: "auth-token" });

// Remove
session.cookies.remove({ name: "auth-token", url: "https://example.com" });

// Clear all
session.cookies.clear();
```

---

## Updater

Built-in auto-update system with binary-diff patching.

### Configuration

```typescript
// electrobun.config.ts
export default {
  // ... app, build ...
  release: {
    baseUrl: "https://releases.myapp.dev",
    generatePatch: true,
  },
};
```

### API

```typescript
import { Updater } from "electrobun/bun";

// Check for updates (fetches manifest, compares hashes)
const updateInfo = await Updater.checkForUpdate();

if (updateInfo.updateAvailable) {
  // Download: tries binary patch first, falls back to full bundle
  Updater.onStatusChange((status) => {
    console.log(`Update: ${status.status}`);
  });

  await Updater.downloadUpdate();

  if (updateInfo.updateReady) {
    // Extract, replace, relaunch
    await Updater.applyUpdate();
  }
}

// Get full status history
const history = Updater.getStatusHistory();
```

### Update Flow

1. `checkForUpdate()` fetches `{baseUrl}/{channel}-{os}-{arch}-update.json`
2. Compares remote hash against local `version.json` hash
3. `downloadUpdate()` attempts patch chain (bsdiff), falls back to full `.tar.zst` bundle
4. `applyUpdate()` extracts, replaces app bundle, relaunches

### Status Events

Checking: `checking` -> `update-available` | `no-update` | `error`
Download: `download-starting` -> `fetching-patch` -> `applying-patch` -> `patch-chain-complete` | `downloading-full-bundle` -> `download-progress` -> `decompressing` -> `download-complete`
Apply: `applying` -> `extracting` -> `replacing-app` -> `launching-new-version` -> `complete`

---

## Events (Lifecycle)

```typescript
import { Electrobun } from "electrobun/bun";

// Before-quit fires on ALL quit paths: programmatic, Cmd+Q, dock, signals, updater
Electrobun.events.on("before-quit", (event) => {
  // Set event.allow = false to cancel the quit
  event.allow = false;  // prevents quit
  // Do cleanup, then:
  Utils.quit();
});

// Application menu clicks
Electrobun.events.on("application-menu-clicked", (event) => {
  console.log(event.action);
});

// Context menu clicks
Electrobun.events.on("context-menu-clicked", (event) => {
  console.log(event.action);
});
```

Quit is unified across: `Utils.quit()`, `process.exit()`, `exitOnLastWindowClosed`, system-initiated (Cmd+Q, dock, taskbar), signals (Ctrl+C, SIGTERM), and updater restarts.

---

## Renderer APIs (electrobun/view)

### Electroview Class

```typescript
import { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<MyRPC>({
  maxRequestTime: 5000,
  handlers: { /* ... */ },
});

const view = new Electroview({ rpc });
```

### window.electroview (Global)

Available in all webviews after preload:

| Method | Description |
|---|---|
| `sendToMain(data)` | Send message to Bun process |
| `onMainMessage(callback)` | Receive messages from Bun |
| `addEventListener(event, handler)` | Subscribe to events |
| `removeEventListener(event, handler)` | Unsubscribe |

### Bridge Objects

| Bridge | Availability | Purpose |
|---|---|---|
| `window.bunBridge` | Non-sandboxed only | User RPC communication |
| `window.eventBridge` | Always | Read-only event notifications |
| `window.internalBridge` | Non-sandboxed only | Internal OOPIF management |

### electrobun-webview Tag

Out-of-process iframe for embedding isolated web content:

```html
<electrobun-webview
  url="https://example.com"
  preload="./preload.js"
  partition="persist:external"
></electrobun-webview>
```

| Attribute | Description |
|---|---|
| `url` | URL to load |
| `html` | Direct HTML content |
| `preload` | Preload script path |
| `partition` | Storage partition |

### Draggable Regions

Use CSS to define draggable areas for custom title bars:

```css
.title-bar {
  -webkit-app-region: drag;
}

.title-bar button {
  -webkit-app-region: no-drag;
}
```

---

## CLI Commands

| Command | Description |
|---|---|
| `electrobun build` | Development build |
| `electrobun build --env=canary` | Canary release build |
| `electrobun build --env=stable` | Stable release build |
| `electrobun dev` | Launch dev build |
| `bunx electrobun init` | Scaffold new project from template |
