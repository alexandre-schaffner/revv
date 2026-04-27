import { Button } from "@revv/solid-ui/components/button";
import type { Component } from "solid-js";

export const HelloWorldPage: Component = () => {
  return (
    <div class="flex min-h-screen items-center justify-center bg-gray-50">
      <div class="text-center space-y-4">
        <h1 class="text-4xl font-bold text-gray-900">Hello World</h1>
        <p class="text-lg text-gray-600">
          Shared view rendered by TanStack Start and ElectroBun
        </p>
        <Button>Click me</Button>
      </div>
    </div>
  );
};
