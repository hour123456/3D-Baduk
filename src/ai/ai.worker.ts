import { AISearchRequest, AISearchResult, MctsEngine } from './MctsEngine';
import { GomokuAI } from './GomokuAI';
import { ensureKataGoModelLoaded, hydrateKataGoModelFromBytes } from './katago/KataGoWeights';

type WorkerRequestMessage =
  | { type: 'hydrateWeights'; bytes: Uint8Array }
  | { id: number; payload: AISearchRequest };

interface WorkerResponseMessage {
  id: number;
  result: AISearchResult;
}

const goEngine = new MctsEngine();
const gomokuAI = new GomokuAI();
let hydrationPromise: Promise<void> | null = null;

async function hydrateWeightsBytes(bytes: Uint8Array): Promise<void> {
  try {
    let raw = bytes;
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([raw as unknown as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('gzip'));
        raw = new Uint8Array(await new Response(stream).arrayBuffer());
      }
    }
    hydrateKataGoModelFromBytes(raw);
  } catch {
    // Ignore invalid weight bytes; ensureKataGoModelLoaded handles fallback
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
  const data = event.data;
  if ('type' in data) {
    if (data.type === 'hydrateWeights' && data.bytes instanceof Uint8Array && data.bytes.byteLength > 0) {
      hydrationPromise = hydrateWeightsBytes(data.bytes);
      await hydrationPromise;
    }
    return;
  }

  const { id, payload } = data;
  if (payload.gameType !== 'omok') {
    try {
      if (hydrationPromise) {
        await hydrationPromise;
      }
      await ensureKataGoModelLoaded();
    } catch {
      // Allow MctsEngine to proceed cleanly even if weights fail to load
    }
  }

  const result =
    payload.gameType === 'omok' ? gomokuAI.chooseMove(payload) : goEngine.chooseMove(payload);
  const response: WorkerResponseMessage = { id, result };
  self.postMessage(response);
};
