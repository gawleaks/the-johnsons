import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../src/rpc/jsonl.js";

describe("JsonlDecoder", () => {
  it("decodes LF-delimited JSON across chunk boundaries", () => {
    const decoder = new JsonlDecoder();

    expect(decoder.push('{"id":1')).toEqual([]);
    expect(decoder.push('}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decoder.finish()).toEqual([]);
  });

  it("accepts CR before LF", () => {
    const decoder = new JsonlDecoder();

    expect(decoder.push('{"ok":true}\r\n')).toEqual([{ ok: true }]);
  });

  it("does not split on U+2028 inside JSON string values", () => {
    const decoder = new JsonlDecoder();

    expect(decoder.push('{"text":"line\u2028break"}\n')).toEqual([{ text: "line\u2028break" }]);
  });

  it("throws Invalid RPC JSON for malformed records", () => {
    const decoder = new JsonlDecoder();

    expect(() => decoder.push('{not json}\n')).toThrow("Invalid RPC JSON");
  });

  it("buffers an incomplete final record", () => {
    const decoder = new JsonlDecoder();

    expect(decoder.push('{"tail":3')).toEqual([]);
    expect(decoder.finish()).toEqual([]);
  });
});
