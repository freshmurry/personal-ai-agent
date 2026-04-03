//src/agent/file-intelligence.ts

export class FileIntelligence {
  constructor(private env: any) {}

  async processFile(key: string, buffer: ArrayBuffer) {
    const ext = key.split('.').pop()?.toLowerCase();

    let text = "";

    if (ext === "pdf") {
      text = await this.parsePDF(buffer);
    } else if (ext === "docx") {
      text = await this.parseDOCX(buffer);
    } else if (["png", "jpg", "jpeg", "webp"].includes(ext!)) {
      text = await this.ocrImage(buffer);
    } else {
      text = new TextDecoder().decode(buffer);
    }

    const chunks = this.chunk(text);

    await this.embedAndStore(key, chunks);

    return { success: true, chunks: chunks.length };
  }

  // -------------------------
  // 📄 PDF PARSER (basic)
  // -------------------------
  async parsePDF(buffer: ArrayBuffer): Promise<string> {
    // 🔴 Replace later with pdfjs worker
    return new TextDecoder().decode(buffer);
  }

  // -------------------------
  // 📄 DOCX PARSER (basic)
  // -------------------------
  async parseDOCX(buffer: ArrayBuffer): Promise<string> {
    return new TextDecoder().decode(buffer);
  }

  // -------------------------
  // 🧠 OCR (REAL)
  // -------------------------
  async ocrImage(buffer: ArrayBuffer): Promise<string> {
    const res = await this.env.AI.run(
      "@cf/llava-hf/llava-1.5-7b-hf",
      {
        image: [...new Uint8Array(buffer)],
        prompt: "Extract all readable text from this image"
      }
    );

    return res.description || "";
  }

  // -------------------------
  // ✂️ CHUNKING
  // -------------------------
  chunk(text: string, size = 500) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }

  // -------------------------
  // 🧠 EMBEDDINGS + VECTORIZE
  // -------------------------
  async embedAndStore(key: string, chunks: string[]) {
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.env.AI.run(
        "@cf/baai/bge-base-en-v1.5",
        { text: chunks[i] }
      );

      await this.env.VECTORIZE.upsert([
        {
          id: `${key}_${i}`,
          values: embedding.data[0],
          metadata: {
            file: key,
            chunk: i,
            text: chunks[i]
          }
        }
      ]);
    }
  }
}