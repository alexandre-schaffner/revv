import { describe, expect, it } from "bun:test";
import { isLoopbackAddress } from "./net";

describe("isLoopbackAddress", () => {
  it("treats every loopback form as local", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress(" 127.0.0.1 ")).toBe(true);
    expect(isLoopbackAddress("::FFFF:127.0.0.1")).toBe(true);
  });

  it("rejects bind-to-all and LAN addresses", () => {
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("172.16.4.9")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});
