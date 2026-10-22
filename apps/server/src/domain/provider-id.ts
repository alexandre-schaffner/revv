export function extractHostFromProviderId(providerId: string): string {
  if (providerId.startsWith("github:")) return providerId.slice("github:".length);
  return "github.com";
}
