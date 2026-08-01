import { describe, expect, it } from "vitest";
import { parseClientFrame } from "../../src/protocol.js";

describe("parseClientFrame", () => {
  it("accepts every client frame type", () => {
    expect(parseClientFrame('{"v":0,"type":"input","data":"λ"}').ok).toBe(true);
    expect(parseClientFrame('{"v":0,"type":"binaryInput","dataBase64":"AAE="}').ok).toBe(true);
    expect(parseClientFrame('{"v":0,"type":"resize","cols":120,"rows":40}').ok).toBe(true);
    expect(parseClientFrame('{"v":0,"type":"replayFrom","seq":1}').ok).toBe(true);
  });

  it("rejects malformed, unknown, oversized dimensions, and noncanonical Base64", () => {
    expect(parseClientFrame("{").ok).toBe(false);
    expect(parseClientFrame('{"v":1,"type":"input","data":"x"}').ok).toBe(false);
    expect(parseClientFrame('{"v":0,"type":"resize","cols":0,"rows":40}').ok).toBe(false);
    expect(parseClientFrame('{"v":0,"type":"resize","cols":501,"rows":40}').ok).toBe(false);
    expect(parseClientFrame('{"v":0,"type":"binaryInput","dataBase64":"AA"}').ok).toBe(false);
    expect(parseClientFrame('{"v":0,"type":"input","data":"x","extra":true}').ok).toBe(false);
  });
});
