import { Coord, GameConfig, BLACK, WHITE, EMPTY } from '../rules/types';
import { TUTORIAL_LESSONS, TutorialLesson, TutorialStep, TutorialStepHighlight } from './TutorialCurriculum';

const TUTORIAL_PROGRESS_KEY = 'sudam_tutorial_progress_v1';

export interface TutorialAttemptOutcome {
  accepted: boolean;
  feedback: string;
  stepCompleted: boolean;
  lessonCompleted: boolean;
  needsOpponentReply?: { x: number; y: number; color: 1 | 2 } | null;
}

export class TutorialController {
  private completedLessonIds = new Set<string>();
  private activeLesson: TutorialLesson | null = null;
  private currentStepIdx = 0;
  private showingHint = false;
  private awaitNextStep = false;

  constructor() {
    this.loadProgress();
  }

  private loadProgress(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const raw = window.localStorage.getItem(TUTORIAL_PROGRESS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string') this.completedLessonIds.add(id);
        }
      }
    } catch {
      // Ignore storage restrictions
    }
  }

  private saveProgress(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(
        TUTORIAL_PROGRESS_KEY,
        JSON.stringify(Array.from(this.completedLessonIds))
      );
    } catch {
      // Ignore storage quota issues
    }
  }

  public getLessons(): ReadonlyArray<TutorialLesson> {
    return TUTORIAL_LESSONS;
  }

  public getCompletedLessonIds(): ReadonlySet<string> {
    return this.completedLessonIds;
  }

  public isActive(): boolean {
    return this.activeLesson !== null;
  }

  public getCurrentLesson(): TutorialLesson | null {
    return this.activeLesson;
  }

  public getCurrentStepIndex(): number {
    return this.currentStepIdx;
  }

  public getCurrentStep(): TutorialStep | null {
    if (!this.activeLesson) return null;
    return this.activeLesson.steps[this.currentStepIdx] ?? null;
  }

  public isAwaitingNextStep(): boolean {
    return this.awaitNextStep;
  }

  public startLesson(lessonId: string): TutorialLesson | null {
    const found = TUTORIAL_LESSONS.find((l) => l.id === lessonId);
    if (!found) return null;
    this.activeLesson = found;
    this.currentStepIdx = 0;
    this.showingHint = false;
    this.awaitNextStep = false;
    return found;
  }

  public resetCurrentStep(): void {
    this.awaitNextStep = false;
    this.showingHint = false;
  }

  public exit(): void {
    this.activeLesson = null;
    this.currentStepIdx = 0;
    this.showingHint = false;
    this.awaitNextStep = false;
  }

  public buildGameConfigForLesson(lesson: TutorialLesson): GameConfig {
    return {
      gameType: lesson.gameType,
      omokRuleset: lesson.omokRuleset ?? 'renju',
      boardSize: lesson.boardSize,
      ruleset: 'korean',
      handicap: 0,
      komi: 0,
      superko: false,
      mode: 'local2p',
      humanColor: BLACK,
      aiDifficulty: 1,
      mainTimeSeconds: 0,
      byoyomiSeconds: 30,
      byoyomiPeriods: 0,
      blackName: '수련생 (흑)',
      whiteName: '사범 도우미 (백)',
    };
  }

  public getActiveHighlights(): TutorialStepHighlight[] {
    const step = this.getCurrentStep();
    if (!step) return [];
    const list: TutorialStepHighlight[] = [...(step.initialHighlights ?? [])];
    if (this.showingHint && step.hintCoords) {
      for (const c of step.hintCoords) {
        if (!list.some((h) => h.x === c.x && h.y === c.y && h.kind === 'target')) {
          list.push({ x: c.x, y: c.y, kind: 'target' });
        }
      }
    }
    return list;
  }

  public toggleHint(): boolean {
    this.showingHint = !this.showingHint;
    return this.showingHint;
  }

  public setShowingHint(on: boolean): void {
    this.showingHint = on;
  }

  public isShowingHint(): boolean {
    return this.showingHint;
  }

  public evaluateMoveAttempt(x: number, y: number): TutorialAttemptOutcome {
    const step = this.getCurrentStep();
    if (!this.activeLesson || !step) {
      return {
        accepted: false,
        feedback: '활성화된 튜토리얼이 없습니다.',
        stepCompleted: false,
        lessonCompleted: false,
      };
    }
    if (this.awaitNextStep) {
      return {
        accepted: false,
        feedback: '단계 완료! 아래 [다음 단계 →] 버튼을 눌러 계속 진행하세요.',
        stepCompleted: false,
        lessonCompleted: false,
      };
    }

    if (step.actionType !== 'move') {
      return {
        accepted: false,
        feedback: step.wrongMoveFeedback,
        stepCompleted: false,
        lessonCompleted: false,
      };
    }

    const accepted = Boolean(step.acceptedMoves?.some((m) => m.x === x && m.y === y));
    if (!accepted) {
      return {
        accepted: false,
        feedback: step.wrongMoveFeedback,
        stepCompleted: false,
        lessonCompleted: false,
      };
    }

    return this.completeCurrentStep(step);
  }

  public evaluatePassAttempt(): TutorialAttemptOutcome {
    const step = this.getCurrentStep();
    if (!this.activeLesson || !step || step.actionType !== 'pass') {
      return {
        accepted: false,
        feedback: step?.wrongMoveFeedback || '이 단계에서는 한수쉼을 사용하지 않습니다.',
        stepCompleted: false,
        lessonCompleted: false,
      };
    }
    return this.completeCurrentStep(step);
  }

  public evaluateDeadStoneAttempt(x: number, y: number): TutorialAttemptOutcome {
    const step = this.getCurrentStep();
    if (!this.activeLesson || !step || step.actionType !== 'mark_dead') {
      return {
        accepted: false,
        feedback: step?.wrongMoveFeedback || '사석 지정 단계가 아닙니다.',
        stepCompleted: false,
        lessonCompleted: false,
      };
    }
    const target = step.targetDeadCoord;
    if (!target || target.x !== x || target.y !== y) {
      return {
        accepted: false,
        feedback: step.wrongMoveFeedback,
        stepCompleted: false,
        lessonCompleted: false,
      };
    }
    return this.completeCurrentStep(step);
  }

  public evaluateConfirmScoreAttempt(): TutorialAttemptOutcome {
    const step = this.getCurrentStep();
    if (!this.activeLesson || !step || step.actionType !== 'confirm_score') {
      return {
        accepted: false,
        feedback: step?.wrongMoveFeedback || '계가 확정 단계가 아닙니다.',
        stepCompleted: false,
        lessonCompleted: false,
      };
    }
    return this.completeCurrentStep(step);
  }

  private completeCurrentStep(step: TutorialStep): TutorialAttemptOutcome {
    this.showingHint = false;
    const isLast = this.activeLesson ? this.currentStepIdx >= this.activeLesson.steps.length - 1 : true;
    this.awaitNextStep = true;

    if (isLast && this.activeLesson) {
      this.completedLessonIds.add(this.activeLesson.id);
      this.saveProgress();
    }

    return {
      accepted: true,
      feedback: step.successFeedback,
      stepCompleted: true,
      lessonCompleted: isLast,
      needsOpponentReply: step.opponentReply ?? null,
    };
  }

  public advanceToNextStep(): { hasNextStep: boolean; nextLesson: TutorialLesson | null } {
    if (!this.activeLesson) return { hasNextStep: false, nextLesson: null };
    this.awaitNextStep = false;
    this.showingHint = false;
    if (this.currentStepIdx + 1 < this.activeLesson.steps.length) {
      this.currentStepIdx += 1;
      return { hasNextStep: true, nextLesson: null };
    }
    const curNum = this.activeLesson.number;
    const nextLesson = TUTORIAL_LESSONS.find((l) => l.number === curNum + 1) ?? null;
    return { hasNextStep: false, nextLesson };
  }
}

export { BLACK, WHITE, EMPTY };
export type { Coord };
