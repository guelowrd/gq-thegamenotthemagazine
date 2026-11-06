// The tag scanner: reads the notes under a tag from the node once, then only what is new, and marks the used ones.
import { describe, expect, it, vi } from "vitest";
import { scanProgress, tagScanner } from "../chain";

// a node with two notes under the tag, the first one used at block 7
const node = vi.hoisted(() => ({ syncs: 0, fetched: 0 }));
const NULLIFIER = { a: "0x" + "1".padStart(64, "0"), b: "0x" + "2".padStart(64, "0") };
vi.mock("@miden-sdk/miden-sdk", async (actual) => ({
  ...(await actual<typeof import("@miden-sdk/miden-sdk")>()),
  RpcClient: class {
    syncNotes = async (from: number, to: number) => {
      node.syncs++;
      return { blocks: () => (from === 0 ? [{ notes: () => [{ noteId: () => "a" }, { noteId: () => "b" }] }] : []), blockTo: () => to };
    };
    getNotesById = async (ids: string[]) => {
      node.fetched += ids.length;
      return ids.map((id) => ({ noteId: id, asInputNote: () => ({ location: () => ({ blockNum: () => 3 }), note: () => ({ nullifier: () => ({ toHex: () => NULLIFIER[id as "a" | "b"] }) }) }) }));
    };
    getNullifierCommitHeight = async (w: { toHex(): string }) => (w.toHex() === NULLIFIER.a ? 7 : undefined);
    free() {}
  },
}));

describe("tagScanner", () => {
  it("decodes each note once, marks the used ones, and only asks the node about new blocks", async () => {
    const scan = tagScanner<{ id: string }>(1);
    const decode = vi.fn((_input: unknown, id: string) => (id === "b" ? { id } : { id, kept: true }));
    const seen: unknown[] = [];
    const stop = scanProgress.subscribe(() => seen.push(scanProgress.get()));
    expect(await scan(10, decode)).toEqual([
      { id: "a", kept: true, createdAt: 3, consumed: true, consumedAt: 7, nullifier: NULLIFIER.a },
      { id: "b", createdAt: 3, consumed: false, nullifier: NULLIFIER.b },
    ]);
    expect(decode).toHaveBeenCalledTimes(2);
    // the read reports its progress over the used-note checks, then clears it
    expect(seen).toEqual([{ done: 0, total: 2 }, { done: 2, total: 2 }, null]);
    stop();
    await scan(10, decode);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(node.fetched).toBe(2);
    const syncs = node.syncs;
    await scan(12, decode);
    expect(node.syncs).toBe(syncs + 1);
  });
});
