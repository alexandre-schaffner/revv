const IPV4_MAPPED_PREFIX = "::ffff:";
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True when `address` is a loopback interface: `localhost`, `::1`, the IPv4
 * `127.0.0.0/8` block, or IPv4-mapped IPv6 (`::ffff:127.0.0.1`). `0.0.0.0`/`::`
 * (bind-to-all) are deliberately NOT loopback.
 */
export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a === "localhost" || a === "::1") return true;
  const bare = a.startsWith(IPV4_MAPPED_PREFIX) ? a.slice(IPV4_MAPPED_PREFIX.length) : a;
  return IPV4_LOOPBACK.test(bare);
}
