import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSound } from "../useSound";

describe("sound", () => {
  beforeEach(() => localStorage.clear());

  it("is on by default and remembers SOUND OFF", () => {
    const { result } = renderHook(() => useSound("home"));
    expect(result.current.on).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
    expect(renderHook(() => useSound("home")).result.current.on).toBe(false);
  });
});
