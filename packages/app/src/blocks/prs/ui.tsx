import { useQuery } from "@tanstack/react-query";
import { listPrs } from "./commands";
import { Block } from "../../components/block";
import { PRList } from "./ui/pr";

export function PrsBlock() {
  const query = useQuery(listPrs.queryOptions());

  return (
    <Block
      name="prs"
      query={query}
      empty="No open pull requests."
      refreshShortcut={{
        keys: { mod: true, shift: true, key: "r" },
        mode: "sidebar",
      }}
    >
      {(prs) => <PRList prs={prs} />}
    </Block>
  );
}
