import { StringDecoder } from "node:string_decoder";

const parseRecord = (record: string): unknown => {
  try {
    return JSON.parse(record);
  } catch {
    throw new Error("Invalid RPC JSON");
  }
};

export class JsonlDecoder {
  #buffer = "";
  #decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);

    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() ?? "";

    return parts.map((part) => parseRecord(part.endsWith("\r") ? part.slice(0, -1) : part));
  }

  finish(): unknown[] {
    this.#buffer += this.#decoder.end();

    return [];
  }
}
