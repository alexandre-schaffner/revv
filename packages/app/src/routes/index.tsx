import { createFileRoute } from "@tanstack/react-router";
import { HistoryBlock } from "../blocks/history/ui";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="h-full">
      <HistoryBlock />
    </div>
  );
}
