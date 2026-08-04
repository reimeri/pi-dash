export interface SequencedOutput {
  seq: number;
  data: string;
  bytes: number;
}

export class OutputRing {
  readonly #entries: SequencedOutput[] = [];
  #bytes = 0;
  #latestSeq = 0;

  constructor(
    readonly maxBytes: number,
    readonly maxChunks = 16_384,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("maxBytes must be a positive safe integer");
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1)
      throw new Error("maxChunks must be a positive safe integer");
  }

  get bytes(): number {
    return this.#bytes;
  }

  get length(): number {
    return this.#entries.length;
  }

  get latestSeq(): number {
    return this.#latestSeq;
  }

  get earliestSeq(): number {
    return this.#entries[0]?.seq ?? this.#latestSeq + 1;
  }

  push(data: string): SequencedOutput {
    const entry = {
      seq: ++this.#latestSeq,
      data,
      bytes: Buffer.byteLength(data, "utf8"),
    };
    this.#entries.push(entry);
    this.#bytes += entry.bytes;
    while (
      (this.#bytes > this.maxBytes || this.#entries.length > this.maxChunks) &&
      this.#entries.length > 1
    ) {
      const removed = this.#entries.shift();
      if (removed) this.#bytes -= removed.bytes;
    }
    if (entry.bytes > this.maxBytes) {
      this.#entries.length = 0;
      this.#bytes = 0;
    }
    return entry;
  }

  canReplayAfter(afterSeq: number): boolean {
    const next = afterSeq + 1;
    return next >= this.earliestSeq && next <= this.latestSeq + 1;
  }

  replayAfter(afterSeq: number): readonly SequencedOutput[] {
    if (!this.canReplayAfter(afterSeq)) return [];
    return this.#entries.filter((entry) => entry.seq > afterSeq);
  }
}
