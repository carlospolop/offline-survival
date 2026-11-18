import { describe, expect, it } from "vitest";
import { probeSource } from "../tools/source-probe.mjs";

describe("source probes", () => {
  it("cancels after reading a signature when a server ignores Range", async () => {
    let cancelled = false;
    const result = await probeSource({ url: "https://example.test/book.pdf", type: "pdf" }, async (_url, options) => {
      expect(options.headers.Range).toBe("bytes=0-31");
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from("%PDF-1.7" + "x".repeat(1024)));
      }, cancel() { cancelled = true; } }), { headers: { "content-length": "100000000000" } });
    });
    expect(cancelled).toBe(true);
    expect(result.signature).toBe(Buffer.from("%PDF-1.7").toString("hex"));
  });

  it("rejects HTML error pages returned with a successful HTTP status", async () => {
    await expect(probeSource({ url: "https://example.test/book.pdf", type: "pdf" }, async () => new Response("<html>Not found</html>"))).rejects.toThrow("Expected a PDF");
  });
});
