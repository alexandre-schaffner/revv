import * as React from "react";
import { cn } from "../../lib/utils";
import { X } from "lucide-react";

export interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
}

function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add...",
  className,
}: TagInputProps) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    if (!query) return suggestions.filter((s) => !value.includes(s));
    return suggestions.filter(
      (s) =>
        !value.includes(s) && s.toLowerCase().includes(query.toLowerCase()),
    );
  }, [query, suggestions, value]);

  const showDropdown = open && filtered.length > 0;

  // Clamp active index when filtered list changes
  React.useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // Scroll active item into view
  React.useEffect(() => {
    if (!showDropdown || !listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, showDropdown]);

  function addTag(tag: string) {
    if (!value.includes(tag)) {
      onChange([...value, tag]);
    }
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  function removeTag(index: number) {
    onChange(value.filter((_, i) => i !== index));
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (showDropdown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[activeIndex]) addTag(filtered[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }

    // Backspace on empty input → remove last tag
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      e.preventDefault();
      removeTag(value.length - 1);
    }

    // Enter with free text (no dropdown match)
    if (e.key === "Enter" && query.trim() && !showDropdown) {
      e.preventDefault();
      addTag(query.trim());
    }
  }

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 min-h-[2.5rem] w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background transition-colors",
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag, i) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-xs font-medium"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(i);
              }}
              className="ml-0.5 rounded-sm hover:bg-secondary-foreground/20 p-px"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so click on suggestion registers
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[60px] bg-transparent outline-none placeholder:text-muted-foreground text-sm py-0.5"
        />
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filtered.map((item, i) => (
            <div
              key={item}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(item);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                "cursor-pointer select-none rounded-sm px-2 py-1.5 text-sm transition-colors",
                i === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

TagInput.displayName = "TagInput";

export { TagInput };
