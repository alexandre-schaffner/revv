let hovered = $state<number | null>(null);

export function getHoveredLayer(): number | null {
  return hovered;
}

export function setHoveredLayer(number: number | null): void {
  hovered = number;
}
