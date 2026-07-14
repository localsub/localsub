import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHistory } from "@/hooks/useHistory";

describe("useHistory", () => {
  it("initializes with given value", () => {
    const { result } = renderHook(() => useHistory("initial"));
    expect(result.current.present).toBe("initial");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("pushes new state", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.push("b"));
    expect(result.current.present).toBe("b");
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undoes to previous state", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.push("b"));
    act(() => result.current.push("c"));
    act(() => result.current.undo());
    expect(result.current.present).toBe("b");
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);
  });

  it("redoes to next state", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.push("b"));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.present).toBe("b");
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("clears future on new push after undo", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.push("b"));
    act(() => result.current.push("c"));
    act(() => result.current.undo());
    act(() => result.current.push("d"));
    expect(result.current.present).toBe("d");
    expect(result.current.canRedo).toBe(false);
    // Can undo to b (not c)
    act(() => result.current.undo());
    expect(result.current.present).toBe("b");
  });

  it("does nothing on undo with empty past", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.undo());
    expect(result.current.present).toBe("a");
  });

  it("does nothing on redo with empty future", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.redo());
    expect(result.current.present).toBe("a");
  });

  it("resets to new value and clears history", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.push("b"));
    act(() => result.current.push("c"));
    act(() => result.current.reset("x"));
    expect(result.current.present).toBe("x");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("respects maxSize limit", () => {
    const { result } = renderHook(() => useHistory(0, 3));
    act(() => result.current.push(1));
    act(() => result.current.push(2));
    act(() => result.current.push(3));
    act(() => result.current.push(4)); // past should be [2, 3, 4 is present]

    // Can undo 3 times (maxSize)
    act(() => result.current.undo());
    expect(result.current.present).toBe(3);
    act(() => result.current.undo());
    expect(result.current.present).toBe(2);
    act(() => result.current.undo());
    expect(result.current.present).toBe(1);
    // Can't undo further — 0 was evicted
    expect(result.current.canUndo).toBe(false);
  });

  it("works with complex objects", () => {
    const { result } = renderHook(() => useHistory({ count: 0, name: "a" }));
    act(() => result.current.push({ count: 1, name: "b" }));
    expect(result.current.present).toEqual({ count: 1, name: "b" });
    act(() => result.current.undo());
    expect(result.current.present).toEqual({ count: 0, name: "a" });
  });

  it("works with arrays", () => {
    const { result } = renderHook(() => useHistory<string[]>(["a"]));
    act(() => result.current.push(["a", "b"]));
    act(() => result.current.push(["a", "b", "c"]));
    act(() => result.current.undo());
    expect(result.current.present).toEqual(["a", "b"]);
  });
});
