import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSound } from "../useSound";

describe("sound", () => {
  it("is on at every visit, even after SOUND OFF the last time", () => {
    const first = renderHook(() => useSound("home"));
    expect(first.result.current.on).toBe(true);
    act(() => first.result.current.toggle());
    expect(first.result.current.on).toBe(false);
    first.unmount();
    expect(renderHook(() => useSound("home")).result.current.on).toBe(true);
  });
});
