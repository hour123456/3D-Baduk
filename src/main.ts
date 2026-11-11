import './styles/main.css';
import {
  BLACK,
  WHITE,
  EMPTY,
  GameConfig,
  PlayerColor,
  opponentColor,
} from './rules/types';
import { GoEngine, coordToLabel } from './rules/GoEngine';
import {
  buildScoreGameResult,
  calculateScore,
  estimateDeadStones,
  toggleDeadChainAt,
} from './rules/scoring';
import { exportToSgf, parseSgf } from './rules/sgf';
import { GameClock } from './rules/clock';
import { AcousticStoneAudioEngine } from './audio/AcousticStoneAudioEngine';
import { SceneManager } from './scene/SceneManager';
import { AIController } from './ai/AIController';
import { UIManager } from './ui/UIManager';

class BadukApp {
  private audio: AcousticStoneAudioEngine;
  private engine: GoEngine;
  private scene: SceneManager;
  private ai: AIController;
  private ui: UIManager;
  private clock: GameClock;

  private aiThinking = false;
  private showMoveNumbers = false;
  private showTerritoryHint = false;
  private deadStoneMask: Uint8Array<ArrayBufferLike> = new Uint8Array(361);
  private reviewMoveIndex = 0;

  constructor() {
    const defaultConfig: GameConfig = {
      boardSize: 19,
      ruleset: 'korean',
      handicap: 0,
      komi: 6.5,
      superko: true,
      mode: 'ai',
      humanColor: BLACK,
      aiDifficulty: 3,
      mainTimeSeconds: 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      blackName: '플레이어 (흑)',
      whiteName: 'AI 중급 (Lv.3)',
    };

    this.audio = new AcousticStoneAudioEngine();
    this.engine = new GoEngine(defaultConfig);
    this.ai = new AIController();

    this.clock = new GameClock({
      onTick: ({ black, white, activeColor }) => {
        const bUrgent = activeColor === BLACK && black.inByoyomi && black.byoyomiTimeLeft <= 10;
        const wUrgent = activeColor === WHITE && white.inByoyomi && white.byoyomiTimeLeft <= 10;
        this.ui?.updateClocks(
          this.clock.formatClockText(BLACK),
          this.clock.formatClockText(WHITE),
          bUrgent,
          wUrgent
        );
      },
      onByoyomiWarning: (_color, secLeft) => {
        this.audio.playByoyomiTick(secLeft);
      },
      onTimeout: (timedOutColor) => {
        this.ai.cancelPending();
        this.aiThinking = false;
        const res = this.engine.timeout(timedOutColor);
        this.audio.playCeremonialChime('finish');
        this.syncAllUI();
        this.ui.showToast(`${timedOutColor === BLACK ? '흑' : '백'} 초읽기 시간 초과! ${res.summaryText}`);
        this.ui.showResultModal(res, this.engine.config);
      },
    });

    const canvasRoot = document.getElementById('canvas-container')!;
    const uiRoot = document.getElementById('ui-root')!;

    this.scene = new SceneManager(canvasRoot, this.audio, defaultConfig.boardSize, {
      onIntersectionHover: (x, y) => this.handleIntersectionHover(x, y),
      onIntersectionClick: (x, y) => this.handleIntersectionClick(x, y),
      onHoverLeave: () => {
        this.ui?.setCoordStatus(this.engine.phase === 'scoring' ? '사석 클릭 지정' : '대기 중');
      },
    });

    this.ui = new UIManager(uiRoot, {
      onStartNewGame: (cfg) => this.startNewGame(cfg),
      onPass: () => this.handleHumanPass(),
      onUndo: () => this.handleUndo(),
      onResign: () => this.handleResign(),
      onToggleMoveNumbers: () => this.toggleMoveNumbers(),
      onToggleTerritoryHint: () => this.toggleTerritoryHint(),
      onToggleCoordinates: () => this.scene.toggleCoordinates(),
      onCameraPreset: (preset) => this.scene.setCameraPreset(preset),
      onStirBowls: () => {
        this.scene.stoneAnimator.stirBowl('black', 0.95, true);
        window.setTimeout(() => this.scene.stoneAnimator.stirBowl('white', 0.82, true), 190);
      },
      onVolumeChange: (vol) => this.audio.setVolume(vol),
      onToggleMute: () => {
        const next = !this.audio.isMuted();
        this.audio.setMuted(next);
        return next;
      },
      onSaveSgf: () => this.saveSgfFile(),
      onOpenSgf: () => this.openSgfFile(),
      onConfirmScoring: () => this.confirmScoring(),
      onResumeFromScoring: () => this.resumeFromScoring(),
      onEnterReview: () => this.enterReviewMode(),
      onScrubReviewMove: (idx) => this.scrubReviewMove(idx),
      onToggleFullscreen: () => this.toggleFullscreen(),
    });

    this.ui.updateGameHeader(defaultConfig);
    this.syncAllUI();
  }

  private isHumanTurn(): boolean {
    if (this.engine.phase !== 'playing' || this.aiThinking) return false;
    if (this.engine.config.mode === 'local2p') return true;
    return this.engine.currentTurn === this.engine.config.humanColor;
  }

  private startNewGame(cfg: GameConfig): void {
    this.audio.ensureReady();
    this.ai.cancelPending();
    this.aiThinking = false;
    this.showTerritoryHint = false;
    this.ui.setHintButtonActive(false);

    this.engine.reset(cfg);
    this.deadStoneMask = new Uint8Array(cfg.boardSize * cfg.boardSize);

    this.scene.setBoardSize(cfg.boardSize);
    this.scene.stoneAnimator.syncBoardSnapshot(this.engine.board, cfg.boardSize, this.engine.captures);
    this.scene.updateMarkers(null, null, null);

    // Orient camera naturally if human chose White in 1P mode
    if (cfg.mode === 'ai' && cfg.humanColor === WHITE) {
      this.scene.setCameraPreset('white');
    } else {
      this.scene.setCameraPreset('default');
    }

    this.ui.updateGameHeader(cfg);
    this.ui.configureReviewBar(false, 0, 0);

    this.clock.configure(cfg.mainTimeSeconds, cfg.byoyomiSeconds, cfg.byoyomiPeriods);
    this.clock.startTurn(this.engine.currentTurn);

    this.audio.playCeremonialChime('start');
    // Subtle authentic stone bowl rattle as players reach for the first stone!
    window.setTimeout(() => {
      const startSide = this.engine.currentTurn === BLACK ? 'black' : 'white';
      this.scene.stoneAnimator.stirBowl(startSide, 0.72, true);
    }, 240);

    this.syncAllUI();
    this.maybeTriggerAITurn();
  }

  private handleIntersectionHover(x: number, y: number): {
    valid: boolean;
    reason?: string;
    showGhost: boolean;
    color: PlayerColor;
  } {
    const label = coordToLabel(x, y, this.engine.size);

    if (this.engine.phase === 'scoring') {
      const hasStone = this.engine.getStone(x, y) !== EMPTY;
      this.ui.setCoordStatus(hasStone ? `${label} · 클릭하여 사석 전환` : `${label}`);
      return {
        valid: hasStone,
        showGhost: false,
        color: this.engine.currentTurn,
      };
    }

    if (!this.isHumanTurn()) {
      this.ui.setCoordStatus(label);
      return { valid: false, showGhost: false, color: this.engine.currentTurn };
    }

    const check = this.engine.validateMove(x, y, this.engine.currentTurn);
    if (check.valid) {
      this.ui.setCoordStatus(`착수 가능 · ${label}`);
      return { valid: true, showGhost: true, color: this.engine.currentTurn };
    } else {
      const reasonShort =
        check.reason === 'KO'
          ? '패 금지'
          : check.reason === 'SUICIDE'
            ? '자살수 금지'
            : check.reason === 'SUPERKO'
              ? '초패 금지'
              : label;
      this.ui.setCoordStatus(reasonShort);
      return {
        valid: false,
        reason: check.reason,
        showGhost: false,
        color: this.engine.currentTurn,
      };
    }
  }

  private handleIntersectionClick(x: number, y: number): void {
    this.audio.ensureReady();

    if (this.engine.phase === 'scoring') {
      if (this.engine.getStone(x, y) === EMPTY) return;
      this.deadStoneMask = toggleDeadChainAt(
        this.engine.board,
        this.engine.size,
        this.deadStoneMask,
        x,
        y
      );
      this.audio.playStonePickup('right', true);
      this.refreshScoringPreview();
      return;
    }

    if (!this.isHumanTurn()) return;

    const moveRes = this.engine.playMove(x, y);
    if (!moveRes.valid || !moveRes.record) {
      if (moveRes.reason && moveRes.reason !== 'OCCUPIED') {
        this.ui.showToast(this.engine.getIllegalReasonKorean(moveRes.reason), true);
      }
      return;
    }

    this.scene.clearHover();
    this.applyMoveToScene(
      x,
      y,
      moveRes.record.color,
      moveRes.capturedCoords ?? [],
      moveRes.adjacentTotalCount ?? 0
    );

    this.clock.startTurn(this.engine.currentTurn);
    this.syncAllUI();
    this.maybeTriggerAITurn();
  }

  private applyMoveToScene(
    x: number,
    y: number,
    color: PlayerColor,
    captured: { x: number; y: number }[],
    adjacentCount: number
  ): void {
    const expectedMoveCount = this.engine.history.length;
    this.scene.updateMarkers(null, null, this.engine.koPoint);
    this.scene.stoneAnimator.animateMovePlacement({
      x,
      y,
      color,
      captured,
      adjacentCount,
    });

    // Reveal last-move marker & move number right as the stone snaps onto the Kaya wood!
    window.setTimeout(() => {
      if (this.engine.history.length === expectedMoveCount && this.engine.phase === 'playing') {
        this.scene.updateMarkers({ x, y }, color, this.engine.koPoint);
        if (this.showMoveNumbers) {
          this.scene.renderMoveNumbers(this.engine.history, this.engine.history.length, this.engine.board);
        }
      }
    }, 205);

    if (this.showTerritoryHint) {
      this.refreshTerritoryHintOverlay();
    }
  }

  private async maybeTriggerAITurn(): Promise<void> {
    if (this.engine.phase !== 'playing') return;
    if (this.engine.config.mode !== 'ai') return;
    if (this.engine.currentTurn === this.engine.config.humanColor) return;

    const aiColor = this.engine.currentTurn;
    this.aiThinking = true;
    this.syncAllUI();

    const lastRecord =
      this.engine.history.length > 0 ? this.engine.history[this.engine.history.length - 1] : null;
    const opponentPassed = lastRecord !== null && lastRecord.coord === null;

    // Gentle minimum natural pause so even Lv.1 doesn't overlap the human stone's snap animation
    const minVisualDelay = new Promise((r) => window.setTimeout(r, 340));

    const [searchRes] = await Promise.all([
      this.ai.requestMove({
        board: new Uint8Array(this.engine.board),
        size: this.engine.size,
        color: aiColor,
        ruleset: this.engine.config.ruleset,
        komi: this.engine.config.komi,
        koPoint: this.engine.koPoint ? { ...this.engine.koPoint } : null,
        captures: { ...this.engine.captures },
        lastMove: lastRecord?.coord ?? null,
        opponentPassed,
        moveCount: this.engine.history.length,
        positionHashes: Array.from(this.engine.positionHashes).map((h) => h.toString()),
        difficulty: this.engine.config.aiDifficulty,
      }),
      minVisualDelay,
    ]);

    if (!searchRes || this.engine.phase !== 'playing') {
      this.aiThinking = false;
      this.syncAllUI();
      return;
    }

    this.aiThinking = false;

    if (searchRes.coord === null) {
      // AI chooses PASS
      this.executePass(aiColor, true);
      return;
    }

    const { x, y } = searchRes.coord;
    const res = this.engine.playMove(x, y);
    if (res.valid && res.record) {
      this.applyMoveToScene(
        x,
        y,
        res.record.color,
        res.capturedCoords ?? [],
        res.adjacentTotalCount ?? 0
      );
      this.clock.startTurn(this.engine.currentTurn);
      this.syncAllUI();
    } else {
      // Fallback safety: if move was somehow rejected, pass cleanly
      this.executePass(aiColor, true);
    }
  }

  private handleHumanPass(): void {
    if (!this.isHumanTurn()) return;
    this.executePass(this.engine.currentTurn, false);
    if (this.engine.phase === 'playing') {
      this.maybeTriggerAITurn();
    }
  }

  private executePass(color: PlayerColor, byAI: boolean): void {
    const rec = this.engine.pass();
    if (!rec) return;

    const who = color === BLACK ? '흑' : '백';
    this.ui.showToast(`${who}${byAI ? ' (AI)' : ''}이(가) 한수쉼(Pass) 하였습니다.`);
    this.scene.updateMarkers(null, null, null);

    if (this.engine.phase === 'scoring') {
      this.enterScoringPhase();
    } else {
      this.clock.startTurn(this.engine.currentTurn);
      this.syncAllUI();
    }
  }

  private enterScoringPhase(): void {
    this.clock.pause();
    this.scene.clearHover();
    this.scene.stoneAnimator.snapAllToRest();
    if (this.showMoveNumbers) {
      this.scene.renderMoveNumbers(this.engine.history, this.engine.history.length, this.engine.board);
    }
    this.deadStoneMask = estimateDeadStones(this.engine.board, this.engine.size);
    this.refreshScoringPreview();
    this.syncAllUI();
    this.ui.showToast('연속 한수쉼으로 사석 지정 및 계가 단계에 진입했습니다.');
  }

  private refreshScoringPreview(): void {
    this.scene.stoneAnimator.updateDeadMaskVisuals(this.deadStoneMask);
    const breakdown = calculateScore({
      board: this.engine.board,
      size: this.engine.size,
      ruleset: this.engine.config.ruleset,
      komi: this.engine.config.komi,
      captures: this.engine.captures,
      deadStoneMask: this.deadStoneMask,
    });
    this.scene.renderTerritoryMap(breakdown.territoryMap);
    this.ui.updateScoringBannerTally(breakdown);
  }

  private confirmScoring(): void {
    if (this.engine.phase !== 'scoring') return;
    const breakdown = calculateScore({
      board: this.engine.board,
      size: this.engine.size,
      ruleset: this.engine.config.ruleset,
      komi: this.engine.config.komi,
      captures: this.engine.captures,
      deadStoneMask: this.deadStoneMask,
    });
    const gameResult = buildScoreGameResult(breakdown);
    this.engine.finalizeScoreResult(gameResult);

    this.audio.playCeremonialChime('finish');
    this.syncAllUI();
    this.ui.showResultModal(gameResult, this.engine.config);
  }

  private resumeFromScoring(): void {
    if (this.engine.phase !== 'scoring') return;
    this.engine.resumePlayingFromScoring();
    this.deadStoneMask.fill(0);
    this.scene.stoneAnimator.updateDeadMaskVisuals(null);
    if (!this.showTerritoryHint) {
      this.scene.clearTerritoryMarkers();
    }
    this.clock.startTurn(this.engine.currentTurn);
    this.syncAllUI();
    this.maybeTriggerAITurn();
  }

  private handleUndo(): void {
    if (this.engine.phase !== 'playing' || this.aiThinking || this.engine.history.length === 0) return;

    // In 1P vs AI mode, undo 2 plies (AI's reply + player's move) so it returns to player's turn
    let steps = 1;
    if (this.engine.config.mode === 'ai') {
      steps = this.engine.history.length >= 2 ? 2 : 1;
    }

    if (this.engine.undo(steps)) {
      this.audio.playStonePickup('left', false);
      this.scene.stoneAnimator.syncBoardSnapshot(
        this.engine.board,
        this.engine.size,
        this.engine.captures
      );
      const last =
        this.engine.history.length > 0 ? this.engine.history[this.engine.history.length - 1] : null;
      this.scene.updateMarkers(last?.coord ?? null, last?.color ?? null, this.engine.koPoint);

      if (this.showMoveNumbers) {
        this.scene.renderMoveNumbers(this.engine.history, this.engine.history.length, this.engine.board);
      }
      if (this.showTerritoryHint) {
        this.refreshTerritoryHintOverlay();
      }

      this.clock.startTurn(this.engine.currentTurn);
      this.syncAllUI();
      this.ui.showToast(`${steps}수 무르기 완료`);
      this.maybeTriggerAITurn();
    }
  }

  private handleResign(): void {
    if (this.engine.phase !== 'playing' || this.aiThinking) return;
    const resigningColor =
      this.engine.config.mode === 'ai' ? this.engine.config.humanColor : this.engine.currentTurn;
    this.clock.stop();
    const res = this.engine.resign(resigningColor);
    this.audio.playCeremonialChime('finish');
    this.syncAllUI();
    this.ui.showResultModal(res, this.engine.config);
  }

  private toggleMoveNumbers(): boolean {
    this.showMoveNumbers = !this.showMoveNumbers;
    if (this.showMoveNumbers) {
      const targetIdx =
        this.engine.phase === 'review' ? this.reviewMoveIndex : this.engine.history.length;
      const snap = this.engine.getSnapshotAtMove(targetIdx);
      this.scene.renderMoveNumbers(this.engine.history, targetIdx, snap.board);
    } else {
      this.scene.clearMoveNumbers();
    }
    return this.showMoveNumbers;
  }

  private toggleTerritoryHint(): boolean {
    this.showTerritoryHint = !this.showTerritoryHint;
    if (this.showTerritoryHint) {
      this.refreshTerritoryHintOverlay();
    } else if (this.engine.phase !== 'scoring') {
      this.scene.clearTerritoryMarkers();
    }
    return this.showTerritoryHint;
  }

  private refreshTerritoryHintOverlay(): void {
    const estDead = estimateDeadStones(this.engine.board, this.engine.size);
    const score = calculateScore({
      board: this.engine.board,
      size: this.engine.size,
      ruleset: this.engine.config.ruleset,
      komi: this.engine.config.komi,
      captures: this.engine.captures,
      deadStoneMask: estDead,
    });
    this.scene.renderTerritoryMap(score.territoryMap);
    const leadTxt =
      score.winner === BLACK
        ? `형세 추산: 흑 약 ${score.margin}집 우세`
        : score.winner === WHITE
          ? `형세 추산: 백 약 ${score.margin}집 우세`
          : '형세 추산: 팽팽한 균형';
    this.ui.showToast(leadTxt);
  }

  private enterReviewMode(): void {
    this.clock.stop();
    this.engine.phase = 'review';
    this.scene.clearTerritoryMarkers();
    this.scene.stoneAnimator.updateDeadMaskVisuals(null);
    this.showMoveNumbers = true;
    this.ui.setMoveNumbersButtonActive(true);
    this.scrubReviewMove(this.engine.history.length);
    this.syncAllUI();
  }

  private scrubReviewMove(moveIdx: number): void {
    this.reviewMoveIndex = Math.max(0, Math.min(this.engine.history.length, moveIdx));
    const snap = this.engine.getSnapshotAtMove(this.reviewMoveIndex);

    this.scene.stoneAnimator.syncBoardSnapshot(snap.board, this.engine.size, snap.captures);
    this.scene.updateMarkers(
      snap.lastMove?.coord ?? null,
      snap.lastMove?.color ?? null,
      snap.lastMove?.koPointAfter ?? null
    );

    if (this.showMoveNumbers) {
      this.scene.renderMoveNumbers(this.engine.history, this.reviewMoveIndex, snap.board);
    }

    this.ui.configureReviewBar(true, this.reviewMoveIndex, this.engine.history.length);
    this.ui.updatePlayersStatus({
      turn: snap.nextTurn,
      phase: this.engine.phase,
      captures: snap.captures,
      aiThinking: false,
      moveCount: this.engine.history.length,
    });
  }

  private async saveSgfFile(): Promise<void> {
    const sgf = exportToSgf(this.engine);
    const defaultName = `sudam-${this.engine.size}x${this.engine.size}-${new Date().toISOString().slice(0, 10)}.sgf`;

    if (window.electronAPI?.isElectron) {
      const res = await window.electronAPI.saveSgf(sgf, defaultName);
      if (!res.canceled) {
        this.ui.showToast('SGF 기보 파일이 저장되었습니다.');
      }
      return;
    }

    // Browser download fallback
    const blob = new Blob([sgf], { type: 'application/x-go-sgf;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
    this.ui.showToast('SGF 기보 파일 다운로드가 시작되었습니다.');
  }

  private async openSgfFile(): Promise<void> {
    if (window.electronAPI?.isElectron) {
      const res = await window.electronAPI.openSgf();
      if (!res.canceled && res.content) {
        this.loadSgfContent(res.content);
      }
      return;
    }

    // Browser file input fallback
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sgf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      this.loadSgfContent(text);
    };
    input.click();
  }

  private loadSgfContent(sgfText: string): void {
    try {
      const parsed = parseSgf(sgfText);
      this.ai.cancelPending();
      this.aiThinking = false;
      this.clock.stop();

      const cfg: GameConfig = {
        ...this.engine.config,
        boardSize: parsed.boardSize,
        komi: parsed.komi,
        ruleset: parsed.ruleset,
        handicap: 0, // Use explicit setupBlack stones from SGF
        mode: 'local2p',
        mainTimeSeconds: 0,
        byoyomiSeconds: 0,
        byoyomiPeriods: 0,
        blackName: parsed.blackName || '흑 (기보)',
        whiteName: parsed.whiteName || '백 (기보)',
      };

      this.engine.reset(cfg);
      for (const pt of parsed.setupBlack) this.engine.setCustomSetupStone(pt.x, pt.y, BLACK);
      for (const pt of parsed.setupWhite) this.engine.setCustomSetupStone(pt.x, pt.y, WHITE);

      for (const m of parsed.moves) {
        this.engine.currentTurn = m.color;
        if (m.coord === null) {
          this.engine.pass();
          if (this.engine.phase === 'scoring') {
            // Allow continuing if SGF has moves after passes
            this.engine.phase = 'playing';
          }
        } else {
          this.engine.playMove(m.coord.x, m.coord.y);
        }
      }

      this.scene.setBoardSize(cfg.boardSize);
      this.ui.updateGameHeader(cfg);
      this.enterReviewMode();
      this.ui.showToast(`기보 불러오기 완료 (${this.engine.history.length}수) — 복기 모드`);
    } catch {
      this.ui.showToast('SGF 기보 파일을 해석할 수 없습니다.', true);
    }
  }

  private async toggleFullscreen(): Promise<void> {
    if (window.electronAPI?.isElectron) {
      await window.electronAPI.toggleFullscreen();
      return;
    }
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  }

  private syncAllUI(): void {
    this.ui.updatePlayersStatus({
      turn: this.engine.currentTurn,
      phase: this.engine.phase,
      captures: this.engine.captures,
      aiThinking: this.aiThinking,
      moveCount: this.engine.history.length,
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new BadukApp();
});
