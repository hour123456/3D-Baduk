import { AISearchRequest, AISearchResult, MctsEngine } from './MctsEngine';

interface WorkerRequestMessage {
  id: number;
  payload: AISearchRequest;
}

interface WorkerResponseMessage {
  id: number;
  result: AISearchResult;
}

const engine = new MctsEngine();

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const { id, payload } = event.data;
  const result = engine.chooseMove(payload);
  const response: WorkerResponseMessage = { id, result };
  self.postMessage(response);
};
