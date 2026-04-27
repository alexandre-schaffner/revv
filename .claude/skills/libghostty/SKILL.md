---
name: libghostty
description: libghostty and libghostty-vt — embeddable terminal emulator libraries from Ghostty. C/Zig APIs for terminal state, VT parsing, and render state management.
when_to_use: When embedding a terminal emulator into an application, building a custom terminal UI, integrating terminal panes into Electrobun/SolidJS/Tauri apps, or using Ghostty's VT engine via FFI in Bun/TypeScript.
version: unstable (libghostty-vt API is functional but not yet semver-stable; full libghostty embedding API is macOS-only and highly unstable)
---

# libghostty

`libghostty` is the embeddable terminal emulator engine extracted from [Ghostty](https://ghostty.org). It ships as two separate libraries:

| Library | Scope | Stability | Use Case |
|---|---|---|---|
| **`libghostty-vt`** | Terminal state machine, VT sequence parsing, scrollback, grid refs, render state | Functional but API in flux | Embed terminal logic in any app; you provide the renderer and windowing |
| **`libghostty`** (full) | Full embedding API with GPU rendering (Metal on macOS, OpenGL on Linux), app/surface lifecycle, config, input | Highly unstable; only macOS app is the consumer today | Native terminal emulator apps with direct platform surface integration |

**Docs:** https://ghostty-org-ghostty.mintlify.app/api/overview  
**Doxygen (libghostty-vt):** https://libghostty.tip.ghostty.org/  
**Source:** https://github.com/ghostty-org/ghostty  
**Examples:** https://github.com/ghostty-org/ghostty/tree/main/examples  
**Ghostling demo:** https://github.com/ghostty-org/ghostling (Raylib + libghostty-vt in C)

## Which Library Should I Use?

- **Use `libghostty-vt`** for almost all embedding scenarios, especially when your app already has a renderer (WebGL, Canvas 2D, WebGPU, or a native UI framework). It is zero-dependency (not even libc if built carefully) and cross-platform.
- **Use full `libghostty`** only if you are building a native macOS terminal app and can tolerate breaking API changes. It handles Metal rendering and NSView integration directly.

In an **Electrobun** app, `libghostty-vt` is the only practical choice today because Electrobun renders UI through OS-native webviews. You run `libghostty-vt` in the Bun main process via FFI, feed it a VT byte stream from a shell PTY, and render the resulting terminal grid into a Canvas or WebGL context inside the webview.

---

## libghostty-vt C API

The public C headers live in `include/ghostty/vt/` in the Ghostty repo. Key headers:
- `ghostty/vt.h` — umbrella header
- `ghostty/vt/terminal.h` — terminal lifecycle, VT writes, resize, modes
- `ghostty/vt/render.h` — `RenderState` for incremental screen diffs
- `ghostty/vt/grid_ref.h` — direct grid cell inspection
- `ghostty/vt/formatter.h` — dump terminal screen to plain text / HTML
- `ghostty/vt/key.h` / `mouse.h` / `focus.h` — encode input events into VT sequences

### Terminal Lifecycle

```c
#include <ghostty/vt.h>

// Create
GhosttyTerminal term = NULL;
GhosttyTerminalOptions opts = {
    .cols = 80,
    .rows = 24,
    .max_scrollback = 10000,
};
GhosttyResult r = ghostty_terminal_new(NULL, &term, opts);
// assert(r == GHOSTTY_SUCCESS);

// Feed raw VT stream (e.g., from a shell PTY)
const char* data = "\033[1;32mhello\033[0m\r\n";
ghostty_terminal_vt_write(term, (const uint8_t*)data, strlen(data));

// Resize
ghostty_terminal_resize(term, 120, 40, /*cell_width_px=*/ 8, /*cell_height_px=*/ 16);

// Free
ghostty_terminal_free(term);
```

### Reading Terminal State

```c
uint16_t cols = 0, rows = 0;
ghostty_terminal_get(term, GHOSTTY_TERMINAL_DATA_COLS, &cols);
ghostty_terminal_get(term, GHOSTTY_TERMINAL_DATA_ROWS, &rows);

// Inspect a single cell via grid ref
GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
GhosttyPoint pt = {
    .tag = GHOSTTY_POINT_TAG_ACTIVE,
    .value = { .coordinate = { .x = 0, .y = 0 } },
};
ghostty_terminal_grid_ref(term, pt, &ref);

GhosttyCell cell = GHOSTTY_INIT_SIZED(GhosttyCell);
ghostty_grid_ref_cell(&ref, &cell);

bool has_text = false;
ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_TEXT, &has_text);
if (has_text) {
    uint32_t cp = 0;
    ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CODEPOINT, &cp);
}

// Always free grid refs when done
ghostty_grid_ref_free(&ref);
```

### Render State (Recommended for UIs)

`RenderState` is an incremental, dirty-region-optimized snapshot of the terminal viewport intended for custom renderers.

```c
GhosttyRenderState rs = NULL;
ghostty_render_state_new(NULL, &rs);

// After writing VT data, update the render state
ghostty_render_state_update(rs, term);

// Iterate rows
GhosttyRenderStateRowIterator iter;
ghostty_render_state_row_iterator_new(rs, &iter);

GhosttyRenderStateRow row;
while (ghostty_render_state_row_iterator_next(&iter, &row)) {
    // Read row cells, styles, colors
    // Exact getters depend on your installed header version
}
```

> **API fluctuation warning:** RenderState row/cell getter signatures are still changing. Verify against `include/ghostty/vt/render.h` in your Ghostty checkout.

### Input Encoding

libghostty-vt can encode key presses and mouse events into the VT byte sequences that a terminal application expects. This is useful when forwarding user input from your UI to the PTY:

```c
GhosttyKeyEvent* ev = ghostty_key_event_new();
ghostty_key_event_set_action(ev, GHOSTTY_ACTION_PRESS);
ghostty_key_event_set_key(ev, GHOSTTY_KEY_L); // or GHOSTTY_KEY_ENTER, etc.
ghostty_key_event_set_mods(ev, GHOSTTY_MODS_SHIFT);

size_t len = 0;
const uint8_t* seq = ghostty_key_encode(ev, &len);
// write(seq, len) to the shell PTY

ghostty_key_event_free(ev);
```

See `ghostty/vt/key.h` and `ghostty/vt/mouse.h` for full enums.

---

## Obtaining / Building the Library

### Option A: Build from Ghostty source (recommended)

```bash
git clone https://github.com/ghostty-org/ghostty.git
cd ghostty
# libghostty-vt
zig build -Doptimize=ReleaseFast -Dlibghostty-vt=true
# Full libghostty (macOS only, unstable)
zig build -Doptimize=ReleaseFast -Dlibghostty=true
```

Artifacts typically land in `zig-out/lib/` and headers in `include/`.

### Option B: Use a prebuilt wrapper

Some community bindings (Dart, etc.) vendor prebuilt libraries. For Bun/TypeScript you will generally load the `.dylib`/`.so`/`.dll` directly via FFI.

---

## Bun FFI Integration

Bun has first-class FFI via `Bun.dlopen()` and `ffi` callbacks. This is the natural way to consume `libghostty-vt` from Electrobun's Bun main process.

### Loading the Library

```typescript
import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import * as path from "node:path";

const libPath = path.join(
  import.meta.dir,
  "../../zig-out/lib/libghostty-vt.dylib" // adjust for your build
);

const lib = dlopen(libPath, {
  // Terminal
  ghostty_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], // allocator*, terminal*, options*
    returns: FFIType.i32, // GhosttyResult
  },
  ghostty_terminal_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
    returns: FFIType.void,
  },
  ghostty_terminal_resize: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  ghostty_terminal_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_terminal_grid_ref: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_grid_ref_cell: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_cell_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_grid_ref_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // RenderState (add as needed)
  ghostty_render_state_new: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_render_state_update: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_render_state_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});
```

> **Note:** You must define C structs in FFI using `new Uint8Array(...)` or `ffi` struct helpers. Since Bun FFI does not automatically map C structs, writing a thin Zig or C wrapper that exposes higher-level helpers (e.g., `terminal_get_cols(term) -> uint16_t`) can significantly reduce marshalling pain.

### Thin Wrapper Strategy (Recommended)

Because libghostty-vt uses many small structs and unions, a thin Zig wrapper compiled to a shared library makes Bun integration much cleaner:

```zig
// wrapper.zig — compiled to libghostty-bun-wrapper.dylib
const c = @cImport({
    @cInclude("ghostty/vt.h");
});

export fn bun_term_new(cols: u16, rows: u16) ?*anyopaque {
    var term: c.GhosttyTerminal = null;
    const opts = c.GhosttyTerminalOptions{ .cols = cols, .rows = rows };
    if (c.ghostty_terminal_new(null, &term, opts) != c.GHOSTTY_SUCCESS) return null;
    return term;
}

export fn bun_term_vt_write(term: ?*anyopaque, bytes: [*]const u8, len: usize) void {
    c.ghostty_terminal_vt_write(@ptrCast(term), bytes, len);
}

export fn bun_term_free(term: ?*anyopaque) void {
    c.ghostty_terminal_free(@ptrCast(term));
}

// Add getters that return plain scalars
export fn bun_term_get_cols(term: ?*anyopaque) u16 {
    var cols: u16 = 0;
    _ = c.ghostty_terminal_get(@ptrCast(term), c.GHOSTTY_TERMINAL_DATA_COLS, &cols);
    return cols;
}
```

Compile with `zig build-lib wrapper.zig -dynamic -I/path/to/ghostty/include` and load `libghostty-bun-wrapper.dylib` via Bun FFI. This avoids manual struct layout bookkeeping in TypeScript.

---

## Electrobun Integration

Electrobun's architecture (Bun main process + webview renderer) maps cleanly to a "terminal backend in Bun, terminal frontend in webview" design.

### Architecture

```
Electrobun Main Process (Bun)
  |
  +-- Bun FFI -> libghostty-vt (terminal state machine)
  +-- Bun.spawn or FFI openpty -> /bin/bash (shell process)
  |
  +-- RPC (Electrobun) -> WebView
        |
        +-- SolidJS/Canvas renderer (user input + screen drawing)
```

### Step-by-Step

1. **Main process** loads `libghostty-vt` via FFI and spawns a shell.
2. **Shell stdout** is piped into `ghostty_terminal_vt_write()`.
3. **Terminal state** is read via grid refs or `RenderState`.
4. **Dirty screen data** is sent to the webview over Electrobun RPC as a compact frame payload (cell runs, cursor position, dimensions).
5. **Webview** draws the frame onto an HTML `<canvas>`.
6. **Keyboard/mouse events** in the webview are encoded (or forwarded raw) over RPC to the main process, which writes them to the shell's stdin or encodes them via `ghostty_key_encode` before writing.

### RPC Schema Example

```typescript
// src/shared/rpc.ts
import type { ElectrobunRPCSchema, RPCSchema } from "electrobun";

interface TerminalRPC extends ElectrobunRPCSchema {
  bun: RPCSchema<{
    requests: {
      termInit: { params: { cols: number; rows: number }; response: { id: string } };
      termResize: { params: { id: string; cols: number; rows: number }; response: void };
      termWriteInput: { params: { id: string; data: Uint8Array }; response: void };
      termReadFrame: { params: { id: string }; response: TerminalFrame | null };
    };
    messages: {
      shellOutput: { id: string; data: Uint8Array }; // bun -> webview (if streaming)
    };
  }>;
  webview: RPCSchema<{
    requests: {
      // none needed if bun pushes frames proactively
    };
    messages: {
      keyInput: { id: string; key: string; modifiers: string[] };
      mouseInput: { id: string; x: number; y: number; button: number; action: "press" | "release" | "move" };
      requestFrame: { id: string };
    };
  }>;
}

// Frame payload (keep it small)
interface TerminalFrame {
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  cells: TerminalCell[]; // or run-length encoded rows
}

interface TerminalCell {
  x: number;
  y: number;
  text: string; // grapheme cluster
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}
```

### Main Process Terminal Service (Sketch)

```typescript
// src/bun/terminal.ts
import { spawn } from "bun";

class TerminalService {
  private terms = new Map<string, { term: any; shell: any }>();

  create(id: string, cols: number, rows: number) {
    // FFI calls to your wrapper
    const term = ffi.bun_term_new(cols, rows);

    // Pipe-based shell (good enough for many cases)
    const shell = spawn(["/bin/bash", "-l"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Pipe shell -> libghostty
    (async () => {
      for await (const chunk of shell.stdout) {
        ffi.bun_term_vt_write(term, chunk, chunk.byteLength);
      }
    })();

    this.terms.set(id, { term, shell });
    return id;
  }

  writeInput(id: string, data: Uint8Array) {
    const t = this.terms.get(id);
    if (!t) return;
    t.shell.stdin.write(data);
  }

  readFrame(id: string): TerminalFrame {
    const t = this.terms.get(id);
    if (!t) return null;

    const cols = ffi.bun_term_get_cols(t.term);
    const rows = ffi.bun_term_get_rows(t.term);

    // Read via grid refs or render state, build frame
    const cells: TerminalCell[] = [];
    // ... loop grid refs, populate cells

    return { cols, rows, cursor: { x: 0, y: 0, visible: true }, cells };
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (!t) return;
    ffi.bun_term_resize(t.term, cols, rows, 8, 16);
  }
}
```

> **PTY caveat:** `Bun.spawn` with pipes does not allocate a PTY, so programs that require a TTY (e.g., `vim`, `tmux`, `git log` with a pager) may misbehave. For a full terminal, create a real PTY via FFI to `posix_openpt` + `grantpt` + `unlockpt`, spawn the shell on the slave side, and read/write the master FD in Bun. A minimal C/Zig helper for this is highly recommended.

### Webview Canvas Renderer (SolidJS Sketch)

```tsx
// src/views/main/Terminal.tsx
import { createSignal, onMount, onCleanup } from "solid-js";

export function Terminal(props: { rpc: any; termId: string }) {
  let canvasRef: HTMLCanvasElement;
  const [frame, setFrame] = createSignal<TerminalFrame | null>(null);

  const CELL_W = 8;
  const CELL_H = 16;

  onMount(() => {
    const ctx = canvasRef.getContext("2d")!;

    // Request initial frame
    props.rpc.send.requestFrame({ id: props.termId });

    // Poll or listen for frames pushed from bun
    const interval = setInterval(async () => {
      const f = await props.rpc.request.termReadFrame({ id: props.termId });
      if (!f) return;
      setFrame(f);
      draw(ctx, f);
    }, 33); // ~30fps

    onCleanup(() => clearInterval(interval));
  });

  function draw(ctx: CanvasRenderingContext2D, f: TerminalFrame) {
    canvasRef.width = f.cols * CELL_W;
    canvasRef.height = f.rows * CELL_H;
    ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);

    for (const cell of f.cells) {
      const x = cell.x * CELL_W;
      const y = cell.y * CELL_H;
      ctx.fillStyle = cell.bg;
      ctx.fillRect(x, y, CELL_W, CELL_H);
      ctx.fillStyle = cell.fg;
      ctx.font = `${cell.bold ? "bold " : ""}${cell.italic ? "italic " : ""}${CELL_H}px monospace`;
      ctx.fillText(cell.text, x, y + CELL_H - 2);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    // Encode key to bytes, or just send a structured message and let bun encode
    props.rpc.send.keyInput({
      id: props.termId,
      key: e.key,
      modifiers: [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(Boolean),
    });
  }

  return (
    <canvas
      ref={canvasRef!}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ "outline": "none", "cursor": "text" }}
    />
  );
}
```

---

## Full libghostty Embedding API (Reference Only)

The full `libghostty` library (not `libghostty-vt`) exposes a higher-level C API in `include/ghostty.h` that handles app lifecycle, configuration, surfaces, and native GPU rendering.

### Lifecycle

```c
#include <ghostty.h>

ghostty_init(argc, argv);

ghostty_config_t config = ghostty_config_new();
ghostty_config_load_default_files(config);
ghostty_config_finalize(config);

ghostty_runtime_config_s runtime = {
    .userdata = my_app,
    .wakeup_cb = my_wakeup_cb,
    .action_cb = my_action_cb,
    .read_clipboard_cb = my_read_clipboard_cb,
    .write_clipboard_cb = my_write_clipboard_cb,
};

ghostty_app_t app = ghostty_app_new(&runtime, config);

// macOS surface
ghostty_surface_config_s surf = ghostty_surface_config_new();
surf.platform_tag = GHOSTTY_PLATFORM_MACOS;
surf.platform.macos.nsview = (__bridge void*)myNSView;
ghostty_surface_t surface = ghostty_surface_new(app, &surf);
```

### Event Loop

```c
while (running) {
    ghostty_app_tick(app);
    ghostty_surface_draw(surface);
}

ghostty_surface_free(surface);
ghostty_app_free(app);
ghostty_config_free(config);
```

> **Warning:** This API is explicitly **not general-purpose**. It is subject to breaking changes and currently only exercised by the Ghostty macOS app. Do not build production features on it unless you maintain a fork or pin a specific Git SHA.

---

## Performance Tips

1. **Do not read the entire grid every frame.** Use `RenderState` row iterators or dirty-region tracking to send only changed cells over RPC.
2. **Batch RPC.** Send a full frame as one RPC request rather than one message per cell.
3. **Font metrics.** Cache `measureText()` results or use a fixed cell size so the webview renderer doesn't need dynamic layout.
4. **OffscreenCanvas.** If Electrobun's webview supports it, render on a worker using `OffscreenCanvas` to keep the main webview thread responsive.
5. **Avoid excessive Bun FFI calls.** The thin Zig wrapper strategy (one FFI call per high-level operation) is faster than dozens of FFI calls per frame.

---

## Common Issues

### `ghostty_terminal_new` returns error
Ensure `cols` and `rows` are non-zero. `max_scrollback` must also be non-zero.

### Grid ref leaks
Always call `ghostty_grid_ref_free()` after `ghostty_terminal_grid_ref()`.

### Colors look wrong
libghostty-vt uses RGBA or palette indices depending on build configuration. Inspect `ghostty/vt/color.h` to decode the exact representation in your version.

### Keyboard encoding mismatch
If `vim` or `emacs` doesn't respond to arrow keys, you are likely forwarding raw `key` strings instead of encoding them through `ghostty_key_encode()` before writing to the PTY.

---

## Summary

- Use **`libghostty-vt`** + **Bun FFI** + **Electrobun RPC/Canvas** for embedded terminals in Electrobun apps.
- Write a thin Zig/C wrapper around `libghostty-vt` to avoid complex struct marshalling in Bun FFI.
- Treat full `libghostty` as reference-only; it is unstable and tied to native GPU surfaces that do not integrate with Electrobun's webview model today.
