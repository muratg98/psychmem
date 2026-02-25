/**
 * Embedding Service
 *
 * Lazy-loads the all-MiniLM-L6-v2 model (384 dimensions, ~25 MB) from
 * HuggingFace Hub on first use.  The model is cached to disk by
 * @huggingface/transformers automatically (TRANSFORMERS_CACHE or
 * ~/.cache/huggingface/hub).
 *
 * Thread-safety: Node.js is single-threaded, so the singleton pattern is safe.
 *
 * Usage:
 *   const vec = await EmbeddingService.embed("I prefer TypeScript over JavaScript");
 *   const sim = EmbeddingService.cosineSimilarity(vecA, vecB);
 */

// We import dynamically to avoid crashing at startup if the package is somehow
// unavailable (e.g. in test environments that don't need embeddings).
let _pipeline: ((text: string | string[], opts?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _loading: Promise<void> | null = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

export const EmbeddingService = {
  /**
   * Whether the embedding model is currently loaded.
   */
  get isLoaded(): boolean {
    return _pipeline !== null;
  },

  /**
   * Embed a single text string.  Returns a Float32Array of length 384.
   * Throws if the model fails to load.
   */
  async embed(text: string): Promise<Float32Array> {
    await ensureLoaded();
    if (!_pipeline) throw new Error('EmbeddingService: pipeline not loaded');

    // Run mean-pooling feature extraction
    const output = await _pipeline(text, { pooling: 'mean', normalize: true }) as {
      data: Float32Array;
    };

    return output.data;
  },

  /**
   * Embed multiple texts in a single batch (more efficient than looping).
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await ensureLoaded();
    if (!_pipeline) throw new Error('EmbeddingService: pipeline not loaded');

    const output = await _pipeline(texts, { pooling: 'mean', normalize: true }) as {
      data: Float32Array;
      dims: number[];
    };

    // output.data is a flat Float32Array of shape [batchSize × dim]
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(output.data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
    }
    return results;
  },

  /**
   * Cosine similarity between two normalised embedding vectors.
   * Both vectors must have the same length.  Returns a value in [-1, 1];
   * higher = more similar.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  },

  /**
   * Serialise a Float32Array to a Buffer for SQLite BLOB storage.
   */
  serialize(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer);
  },

  /**
   * Deserialise a SQLite BLOB (Buffer / Uint8Array) back to Float32Array.
   */
  deserialize(blob: Buffer | Uint8Array): Float32Array {
    const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  },

  /** Number of dimensions for the loaded model. */
  get dim(): number {
    return EMBEDDING_DIM;
  },
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function ensureLoaded(): Promise<void> {
  if (_pipeline) return;
  if (_loading) return _loading;

  _loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Disable the browser check — we're running in Node.
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.proxy = false;
    }
    const pipe = await pipeline('feature-extraction', MODEL_NAME);
    _pipeline = pipe as unknown as typeof _pipeline;
  })();

  await _loading;
}
