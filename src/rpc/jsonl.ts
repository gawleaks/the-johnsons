const toText = (chunk: Buffer | string): string => (typeof chunk === "string" ? chunk : chunk.toString("utf8"));

const parseRecord = (record: string): unknown => {
  try {
    return JSON.parse(record);
  } catch {
    throw new Error("Invalid RPC JSON");
  }
};

export class JsonlDecoder {
  #buffer = "";

  push(chunk: Buffer | string): unknown[] {
    this.#buffer += toText(chunk);

    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() ?? "";

    return parts.map((part) => parseRecord(part.endsWith("\r") ? part.slice(0, -1) : part));
  }

  finish(): unknown[] {
    return [];
  }
}
