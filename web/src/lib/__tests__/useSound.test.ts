import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSound } from "../useSound";

describe("sound", () => {
  beforeEach(() => sessionStorage.clear());

  it("is on at a new visit; SOUND OFF holds for the visit, reloads included", () => {
    const first = renderHook(() => useSound("home"));
    expect(first.result.current.on).toBe(true);
    act(() => first.result.current.toggle());
    expect(first.result.current.on).toBe(false);
    first.unmount();
    // a reload in the same tab
    expect(renderHook(() => useSound("home")).result.current.on).toBe(false);
    // a new tab
    sessionStorage.clear();
    expect(renderHook(() => useSound("home")).result.current.on).toBe(true);
  });
});
