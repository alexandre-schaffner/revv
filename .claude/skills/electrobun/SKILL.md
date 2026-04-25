---
name: electrobun
description: Electrobun desktop application framework - build cross-platform desktop apps with TypeScript, Bun runtime, and native webviews
when_to_use: When working on Electrobun desktop applications, creating windows, setting up IPC/RPC, configuring builds, using native APIs (menus, tray, dialogs), auto-updates, or migrating from Electron/Tauri to Electrobun
version: v1.x (v1.0 released 2026-02-06, latest npm ~1.12.x)
---

# Electrobun

Electrobun is a framework for building cross-platform desktop applications entirely in TypeScript. It uses the **Bun runtime** for the main process and the **OS-native webview** for rendering (WebKit on macOS, WebView2/Edge on Windows, WebKitGTK on Linux). Native bindings are written in Zig, C++, and Objective-C.

**Key characteristics:**
- ~12-14 MB self-extracting bundles (vs ~200+ MB for Electron)
- <50ms cold start
- Binary-diff updates as small as 14 KB via bsdiff/bspatch
- Encrypted, typed RPC between main process and webviews (AES-256-GCM)
- Optional CEF (Chromium) bundling for rendering consistency
- Optional WebGPU surface via Dawn (no webview needed)

**Docs:** https://blackboard.sh/electrobun/docs/
**GitHub:** https://github.com/blackboardsh/electrobun
**npm:** `electrobun` (latest v1.12.x)

## Architecture

Electrobun apps run as **three OS-level processes**:

1. **Launcher** (Zig binary) -- OS entry point; loads the native wrapper library and spawns Bun.
2. **Main process** (Bun worker thread) -- Runs your TypeScript application code. Manages windows/views via FFI calls to the native wrapper.
3. **Renderer processes** (webviews) -- One per BrowserView. Isolated OS processes communicating with the main process over an encrypted WebSocket channel.

```
Launcher (Zig)
  |
  +-- Native Wrapper (dylib/dll/so: Obj-C++ / C++ / C++)
  |     manages: NSWindow/WKWebView, HWND/WebView2, GtkWindow/WebKit2GTK
  |
  +-- Bun Main Process (worker thread)
        |
        +-- BrowserWindow + BrowserView
        |     |
        |     +-- Renderer (webview, separate OS process)
        |           communicates via encrypted WebSocket RPC
        +-- Tray, Menus, GlobalShortcut, Updater, etc.
```

### Import Paths

| Entry point | Process | Purpose |
|---|---|---|
| `electrobun/bun` (or `electrobun`) | Main (Bun) | Window management, native APIs, lifecycle |
| `electrobun/view` | Renderer (webview) | RPC client, Electroview class |

Importing `electrobun/bun` in a webview throws a runtime error. Keep process boundaries clean.

### Native Bridge (FFI)

The main process communicates with the native wrapper via three mechanisms:
- **Direct FFI symbols** (`native.symbols.*`) -- simple C function calls
- **FFI requests** (`ffi.request.*`) -- structured operations with parameter marshalling
- **JSCallback** -- native code triggering JS callbacks for events

Source: `package/src/bun/proc/native.ts` using `Bun.dlopen()`.

## Quick Start

### Prerequisites
- **Bun** runtime installed
- **macOS 14+**: Xcode command-line tools, CMake (`brew install cmake`)
- **Windows 11+**: Visual Studio Build Tools with C++ workload, CMake
- **Linux (Ubuntu 22.04+)**: `build-essential cmake pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`

### Create a Project

```bash
bunx electrobun init    # interactive template picker
cd my-app
bun install
bun start               # builds + launches dev mode
```

Available templates: `hello-world`, `svelte`, `react-tailwind-vite`, `vue`, `angular`, `solid`, `tray-app`, `multi-window`, `notes-app`, `photo-booth`, `wgpu-threejs`, `wgpu-babylon`, `tailwind-vanilla`, and more.

### Manual Setup

```bash
mkdir my-app && cd my-app
bun init .
bun add electrobun
```

**package.json scripts:**
```json
{
  "scripts": {
    "dev": "bun run build:dev && electrobun dev",
    "build:dev": "bun install && electrobun build",
    "build:stable": "electrobun build --env=stable"
  }
}
```

### Project Structure

```
my-app/
  electrobun.config.ts        # build + app configuration
  package.json
  src/
    bun/
      index.ts                # main process entry
    views/
      main/
        index.html            # renderer HTML
        index.ts              # renderer script
        style.css
```

### Minimal Configuration

```typescript
// electrobun.config.ts
export default {
  app: {
    name: "My App",
    identifier: "dev.my.app",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/views/main/index.html",
      },
    },
  },
};
```

### Minimal Main Process

```typescript
// src/bun/index.ts
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "My App",
  url: "views://main/index.html",
});
```

The `views://` protocol resolves to bundled view assets configured in `electrobun.config.ts`.

## Core Concepts

### BrowserWindow

Creates a native OS window with an automatically attached BrowserView. See [api-reference.md](./api-reference.md) for full options and methods.

### BrowserView

Manages a webview instance. Created automatically by BrowserWindow, or manually for advanced use. Can also be created via the `<electrobun-webview>` custom HTML element for nested out-of-process iframes (OOPIFs).

### RPC (Remote Procedure Call)

Typed, bidirectional communication between Bun and webview processes. Two message types:
- **Requests** -- `Promise<T>` return, with timeout and error propagation
- **Messages** -- fire-and-forget, no response

Schema is defined once in a shared type, implemented on both sides. See [api-reference.md](./api-reference.md) and [examples.md](./examples.md) for patterns.

### Lifecycle and Events

- `Electrobun.events.on("before-quit", handler)` -- fires on all quit paths
- `Utils.quit()` -- programmatic quit (fires before-quit)
- `runtime.exitOnLastWindowClosed` config option
- Window events: `close`, `focus`, `blur`, `resize`, `move`

### Auto-Updates

Built-in updater with binary-diff patching. Configure `release.baseUrl` in config, call `Updater.checkForUpdate()` / `downloadUpdate()` / `applyUpdate()`. See [api-reference.md](./api-reference.md).

### Build Modes

| Command | Mode | Output |
|---|---|---|
| `electrobun build` | Development | Local build directory |
| `electrobun build --env=canary` | Canary | Distributable + update artifacts |
| `electrobun build --env=stable` | Stable | Distributable + update artifacts |
| `electrobun dev` | Run | Launches the dev build |

## Platform Support

| Platform | Status | Webview Engine |
|---|---|---|
| macOS 14+ | Official | WebKit (WKWebView) |
| Windows 11+ | Official | WebView2 (Chromium/Edge) |
| Ubuntu 22.04+ | Official | WebKit2GTK |
| Other Linux (GTK3 + WebKit2GTK 4.1) | Community | WebKit2GTK |

Cross-compilation targets: `macos-x64`, `macos-arm64`, `win32-x64`, `linux-x64`, `linux-arm64`.

## Supporting Files

- [api-reference.md](./api-reference.md) -- Full API surface: BrowserWindow, BrowserView, RPC, Menus, Tray, Utils, Updater, Events, Session, Screen, GlobalShortcut, Configuration
- [examples.md](./examples.md) -- Copy-paste code for common patterns
- [best-practices.md](./best-practices.md) -- Performance, security, testing, migration from Electron/Tauri
