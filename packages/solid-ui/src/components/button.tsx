import { type Component, type JSX, splitProps } from "solid-js";
import { cn } from "../lib/utils";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline";
}

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class"]);

  return (
    <button
      class={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        local.variant === "outline"
          ? "border border-gray-300 bg-white text-gray-900 hover:bg-gray-100"
          : "bg-blue-600 text-white hover:bg-blue-700",
        local.class,
      )}
      {...rest}
    />
  );
};
