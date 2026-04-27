import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  worktreeCount: z.number().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type Workspace = z.infer<typeof workspaceSchema>;
