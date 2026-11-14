import { AISearchRequest, AISearchResult, MctsEngine } from './MctsEngine';
import { GomokuAI } from './GomokuAI';

interface WorkerRequestMessage {
  id: number;
  payload: AISearchRequest;
}

interface WorkerResponseMessage {
  id: number;
  result: AISearchResult;
}

const goEngine = new MctsEngine();
const gomokuAI = new GomokuAI();

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const { id, payload } = event.data;
  const result =
    payload.gameType === 'omok' ? gomokuAI.chooseMove(payload) : goEngine.chooseMove(payload);
  const response: WorkerResponseMessage = { id, result };
  self.postMessage(response);
};
