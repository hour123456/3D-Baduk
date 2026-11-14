import { AISearchRequest, AISearchResult } from './MctsEngine';

export class AIController {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private activeResolve: ((res: AISearchResult | null) => void) | null = null;
  private activeId = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (event: MessageEvent<{ id: number; result: AISearchResult }>) => {
      const { id, result } = event.data;
      if (id === this.activeId && this.activeResolve) {
        const resolve = this.activeResolve;
        this.activeResolve = null;
        resolve(result);
      }
    };
  }

  public requestMove(payload: AISearchRequest): Promise<AISearchResult | null> {
    if (!this.worker) this.initWorker();
    if (this.activeResolve) {
      this.activeResolve(null);
      this.activeResolve = null;
    }

    const id = this.nextRequestId++;
    this.activeId = id;

    return new Promise((resolve) => {
      this.activeResolve = resolve;
      this.worker!.postMessage({ id, payload });
    });
  }

  public cancelPending(): void {
    if (this.activeResolve) {
      // Terminate & respawn worker if mid-heavy search so cancellation is instantaneous
      this.activeResolve(null);
      this.activeResolve = null;
      this.activeId = -1;
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.initWorker();
    }
  }
}
