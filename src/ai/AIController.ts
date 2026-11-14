import { AISearchRequest, AISearchResult } from './MctsEngine';

export class AIController {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private activeResolve: ((res: AISearchResult | null) => void) | null = null;
  private activeId = 0;
  private nativeActive = false;
  private bundledWeightsPromise: Promise<Uint8Array | null> | null = null;

  constructor() {
    this.initWorker();
  }

  private getBundledWeightsOnce(): Promise<Uint8Array | null> {
    if (!this.bundledWeightsPromise) {
      const reader = typeof window !== 'undefined' ? window.electronAPI?.readKataGoWeights : undefined;
      this.bundledWeightsPromise = reader
        ? reader().catch(() => null)
        : Promise.resolve(null);
    }
    return this.bundledWeightsPromise;
  }

  private initWorker(): void {
    const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;

    worker.onmessage = (event: MessageEvent<{ id: number; result: AISearchResult }>) => {
      const { id, result } = event.data;
      if (id === this.activeId && this.activeResolve) {
        const resolve = this.activeResolve;
        this.activeResolve = null;
        resolve(result);
      }
    };

    if (typeof window !== 'undefined' && window.electronAPI?.readKataGoWeights) {
      void this.getBundledWeightsOnce().then((bytes) => {
        if (bytes && bytes.byteLength > 0 && this.worker === worker) {
          // Send a copy so cached bytes remain intact if worker is respawned
          const copy = new Uint8Array(bytes);
          worker.postMessage({ type: 'hydrateWeights', bytes: copy }, [copy.buffer]);
        }
      });
    }
  }

  public async requestMove(payload: AISearchRequest): Promise<AISearchResult | null> {
    if (this.activeResolve) {
      this.activeResolve(null);
      this.activeResolve = null;
    }

    const id = this.nextRequestId++;
    this.activeId = id;

    if (
      payload.gameType !== 'omok' &&
      typeof window !== 'undefined' &&
      window.electronAPI?.katagoAnalyze
    ) {
      this.nativeActive = true;
      try {
        const nativeRes = await window.electronAPI.katagoAnalyze(payload);
        if (id !== this.activeId) {
          return null;
        }
        this.nativeActive = false;
        if (nativeRes?.available && nativeRes.result) {
          return nativeRes.result;
        }
      } catch {
        this.nativeActive = false;
        if (id !== this.activeId) {
          return null;
        }
      }
    }

    if (id !== this.activeId) {
      return null;
    }

    if (!this.worker) this.initWorker();

    return new Promise((resolve) => {
      this.activeResolve = resolve;
      this.worker!.postMessage({ id, payload });
    });
  }

  public cancelPending(): void {
    this.activeId = -1;
    if (this.nativeActive) {
      this.nativeActive = false;
      void window.electronAPI?.katagoCancel?.();
    }
    if (this.activeResolve) {
      // Terminate & respawn worker if mid-heavy search so cancellation is instantaneous
      this.activeResolve(null);
      this.activeResolve = null;
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.initWorker();
    }
  }
}
