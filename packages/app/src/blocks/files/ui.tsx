import { useQuery } from "@tanstack/react-query";
import { listFiles } from "./commands";
import { Block } from "../../components/block";

export function FilesBlock() {
  const query = useQuery(listFiles.queryOptions());

  return (
    <Block
      name="files"
      query={query}
      empty="Empty directory."
      refreshShortcut={{
        keys: { mod: true, shift: true, key: "r" },
        mode: "sidebar",
      }}
    >
      {(files) => (
        <div className="py-1">
          {files.map((file) => (
            <div
              key={file.name}
              className="flex items-center gap-2 px-3 py-0.5 text-xs font-mono hover:bg-accent/50 transition-colors"
            >
              <span className="text-muted-foreground w-3 text-center shrink-0">
                {file.isDir ? "d" : " "}
              </span>
              <span
                className={
                  file.isDir
                    ? "text-foreground"
                    : "text-muted-foreground"
                }
              >
                {file.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}
