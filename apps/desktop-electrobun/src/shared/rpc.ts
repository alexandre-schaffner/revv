import type { ElectrobunRPCSchema, RPCSchema } from "electrobun";

interface AppRPC extends ElectrobunRPCSchema {
  bun: RPCSchema<{
    requests: {
      // Workspace operations moved to Elysia REST API
      // Reserved for future native operations (file picker, notifications, etc.)
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
}

export type { AppRPC };
