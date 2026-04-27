export interface Workspace {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  worktreeCount: number | null;
}
