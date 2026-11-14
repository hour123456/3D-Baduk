import './styles/main.css';
import {
  BLACK,
  WHITE,
  EMPTY,
  Coord,
  AIDifficulty,
  GameConfig,
  GameResult,
  GameType,
  OmokRulesetType,
  PlayerColor,
  opponentColor,
} from './rules/types';
import { GoEngine, coordToLabel } from './rules/GoEngine';
import { GomokuEngine } from './rules/GomokuEngine';
import {
  buildScoreGameResult,
  calculateScore,
  estimateDeadStones,
  toggleDeadChainAt,
} from './rules/scoring';
import { exportToSgf, parseSgf } from './rules/sgf';
import { ClockSnapshot, GameClock } from './rules/clock';
import { AcousticStoneAudioEngine } from './audio/AcousticStoneAudioEngine';
import { CameraPreset, SceneManager } from './scene/SceneManager';
import { AIController } from './ai/AIController';
import { UIManager } from './ui/UIManager';
import {
  SettingsManager,
  UserSettings,
  isMobileOrTouchViewport,
  resolveEffectiveInputMode,
} from './settings/SettingsManager';
import { ProfileManager, generateDefaultNickname } from './profile/ProfileManager';
import { MultiBrokerTransport } from './online/MultiBrokerTransport';
import { OnlineMatchManager, normalizeRoomCode } from './online/OnlineMatchManager';
import { SyncSnapshotPayload } from './online/types';

class BadukApp {
  private profile: ProfileManager;
  private settings: SettingsManager;
  private online: OnlineMatchManager;
  private audio: AcousticStoneAudioEngine;
  private engine: GoEngine | GomokuEngine;
  private scene: SceneManager;
  private ai: AIController;
  private ui: UIManager;
  private clock: GameClock;

  private aiThinking = false;
  private hintThinking = false;
  private pendingOnlineUndo = false;
  private showMoveNumbers = false;
  private showTerritoryHint = false;
  private deadStoneMask: Uint8Array<ArrayBufferLike> = new Uint8Array(361);
  private reviewMoveIndex = 0;
  private pendingCoord: Coord | null = null;
  private doubleTapCoord: Coord | null = null;
  private doubleTapAt = 0;
  private moveBlackWinrates: Array<number | undefined> = [];

  constructor() {
    this.profile = new ProfileManager();
    this.settings = new SettingsManager();
    const initialSettings = this.settings.get();

    const defaultConfig: GameConfig = {
      boardSize: 19,
      ruleset: 'korean',
      gameType: 'baduk',
      omokRuleset: 'renju',
      handicap: 0,
      komi: 6.5,
      superko: true,
      mode: 'ai',
      humanColor: BLACK,
      aiDifficulty: 3,
      mainTimeSeconds: 600,
      byoyomiSeconds: 30,
      byoyomiPeriods: 3,
      blackName: this.profile.getNickname(),
      whiteName: 'AI 중급 (Lv.3)',
    };

    this.audio = new AcousticStoneAudioEngine();
    this.audio.setVolume(initialSettings.soundVolume);
    this.audio.setMuted(initialSettings.soundMuted);
    this.engine = this.createEngine(defaultConfig);
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
        if (this.engine.phase !== 'playing') return;
        this.ai.cancelPending();
        this.aiThinking = false;

        if (this.engine.config.mode === 'online') {
          this.online.sendTimeout(timedOutColor);
        }

        const res = this.engine.timeout(timedOutColor);
        this.audio.playCeremonialChime('finish');
        this.syncAllUI();
        this.ui.showToast(
          `${timedOutColor === BLACK ? '흑' : '백'} 초읽기 시간 초과! ${res.summaryText}`
        );
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
    this.applySettingsToScene(initialSettings, false);

    const transport = new MultiBrokerTransport(this.profile.getClientId());
    this.online = new OnlineMatchManager(this.profile, transport, {
      onStatusChange: (status, label) => {
        this.ui?.setOnlineTransportState(status, label);
      },
      onPhaseChange: (phase) => {
        this.ui?.setOnlineLobbyPhase(phase);
      },
      onOpenRoomsUpdated: (rooms) => {
        this.ui?.renderOpenRooms(rooms);
      },
      onWaitingRoomReady: (room, isPublic) => {
        this.ui?.showWaitingRoom(room, isPublic);
        this.ui?.showToast(
          isPublic
            ? `공개 대국방(${room.roomCode})이 개설되었습니다.`
            : `비공개 대국방(${room.roomCode})이 개설되었습니다.`
        );
      },
      onMatchStart: (cfg, role, isRematch) => {
        this.audio.ensureReady();
        this.ui.markGameStartedAndCloseModals();
        this.startNewGame(cfg, true);
        this.ui.setOnlineInGameHUD(true, role.roomCode, role.myColor);
        const stoneLabel = role.myColor === BLACK ? '흑번(선공)' : '백번(덤 수령)';
        this.ui.showToast(
          `${isRematch ? '재대국 시작!' : '온라인 매칭 성사!'} ${role.opponentName}님과 대국합니다 (${stoneLabel})`
        );
      },
      onRemoteMove: (payload) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'playing') return;
        if (payload.moveNumber !== this.engine.history.length + 1) {
          // Request state sync if packet arrived out of sequence
          return;
        }
        const moveRes = this.engine.playMove(payload.x, payload.y);
        if (!moveRes.valid || !moveRes.record) return;

        this.scene.clearHover();
        this.clearAIHints();
        this.applyMoveToScene(
          payload.x,
          payload.y,
          moveRes.record.color,
          moveRes.capturedCoords ?? [],
          moveRes.adjacentTotalCount ?? 0
        );

        if (this.engine.result && (this.engine.phase as string) === 'finished') {
          this.handleGameResultIfFinished(this.engine.result);
          this.syncAllUI();
          return;
        }

        if (payload.clock) {
          this.clock.applySnapshot(payload.clock, this.engine.currentTurn);
        } else {
          this.clock.startTurn(this.engine.currentTurn);
        }
        this.syncAllUI();
      },
      onRemotePass: (payload) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'playing') return;
        if (payload.moveNumber !== this.engine.history.length + 1) return;
        this.executePass(payload.color, false, true, payload.clock);
      },
      onRemoteDeadToggle: (payload) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'scoring') return;
        const nextMask = new Uint8Array(this.engine.size * this.engine.size);
        for (const idx of payload.deadIndices) {
          if (idx >= 0 && idx < nextMask.length) nextMask[idx] = 1;
        }
        this.deadStoneMask = nextMask;
        this.audio.playStonePickup('left', true);
        this.refreshScoringPreview();
      },
      onScoreAgreementChanged: (state, deadIndices) => {
        if (this.engine.config.mode !== 'online') return;
        if (deadIndices && this.engine.phase === 'scoring') {
          const syncedMask = new Uint8Array(this.engine.size * this.engine.size);
          for (const idx of deadIndices) {
            if (idx >= 0 && idx < syncedMask.length) syncedMask[idx] = 1;
          }
          this.deadStoneMask = syncedMask;
          this.refreshScoringPreview();
        }
        this.ui.updateOnlineScoringAgreement(true, this.engine.config.humanColor, state);
      },
      onScoreBothAgreed: () => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'scoring') return;
        this.finalizeScoringNow();
      },
      onRemoteScoreResume: (byColor) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'scoring') return;
        this.resumeFromScoring(true);
        this.ui.showToast(`${byColor === BLACK ? '흑' : '백'} 대국자가 대국 재개를 요청하여 실전으로 복귀합니다.`);
      },
      onRemoteResign: (color) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'playing') return;
        this.clock.stop();
        const res = this.engine.resign(color);
        this.audio.playCeremonialChime('finish');
        this.syncAllUI();
        this.ui.showToast(`상대방이 기권하였습니다. ${res.summaryText}`);
        this.ui.showResultModal(res, this.engine.config);
      },
      onRemoteTimeout: (timedOutColor) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'playing') return;
        this.clock.stop();
        const res = this.engine.timeout(timedOutColor);
        this.audio.playCeremonialChime('finish');
        this.syncAllUI();
        this.ui.showToast(
          `${timedOutColor === BLACK ? '흑' : '백'} 시간 초과! ${res.summaryText}`
        );
        this.ui.showResultModal(res, this.engine.config);
      },
      onUndoRequested: (requesterColor, steps) => {
        if (this.engine.config.mode !== 'online' || this.engine.phase !== 'playing') return;
        const who = requesterColor === BLACK ? '흑' : '백';
        this.ui.showOnlinePrompt(
          `${who} 대국자가 ${steps}수 무르기를 요청했습니다. 수락하시겠습니까?`,
          () => {
            this.performUndoSteps(steps);
            this.online.respondUndo(true, steps, this.clock.getSnapshot());
            this.ui.showToast(`${steps}수 무르기를 수락했습니다.`);
          },
          () => {
            this.online.respondUndo(false, steps);
            this.ui.showToast('무르기 요청을 거절했습니다.');
          }
        );
      },
      onUndoResolved: (accepted, steps, clock) => {
        this.pendingOnlineUndo = false;
        if (accepted) {
          this.performUndoSteps(steps, clock);
          this.ui.showToast(`상대방이 수락하여 ${steps}수 무르기가 적용되었습니다.`);
        } else {
          this.ui.showToast('상대방이 무르기 요청을 거절했습니다.', true);
        }
      },
      onRematchRequested: (requesterColor) => {
        const who = requesterColor === BLACK ? '흑' : '백';
        this.ui.showOnlinePrompt(
          `${who} 대국자가 흑·백 교대 재대국을 신청했습니다. 수락하시겠습니까?`,
          () => {
            this.online.respondRematch(true);
          },
          () => {
            this.online.respondRematch(false);
          }
        );
      },
      onRematchDeclined: () => {
        this.ui.resetRematchButton();
        this.ui.showToast('상대방이 재대국 신청을 정중히 거절했습니다.', true);
      },
      onRemoteChat: (senderName, senderColor, text) => {
        this.audio.playStonePickup(senderColor === BLACK ? 'right' : 'left', true);
        this.ui.showChatBubble(senderColor, senderName, text);
      },
      onOpponentLeft: (opponentName) => {
        this.ui.hideOnlinePrompt();
        if (this.engine.phase === 'playing' || this.engine.phase === 'scoring') {
          this.clock.stop();
          const oppColor = opponentColor(this.engine.config.humanColor);
          const res = this.engine.resign(oppColor);
          this.audio.playCeremonialChime('finish');
          this.syncAllUI();
          this.ui.showToast(`${opponentName}님이 대국방을 퇴장하여 기권승 처리되었습니다.`);
          this.ui.showResultModal(res, this.engine.config);
        } else {
          this.ui.showToast(`${opponentName}님이 대국방을 나갔습니다.`);
        }
      },
      onLatencyUpdated: (pingMs) => {
        const role = this.online.getRoleInfo();
        if (role && this.engine.config.mode === 'online') {
          this.ui.updateOnlinePing(role.roomCode, role.myColor, pingMs);
        }
      },
      onSyncRequested: () => this.buildSyncSnapshot(),
      onSyncSnapshotReceived: (snap) => this.applySyncSnapshot(snap),
      onError: (msg) => {
        this.ui?.showToast(msg, true);
      },
    });

    this.ui = new UIManager(uiRoot, this.profile.getNickname(), initialSettings, {
      onStartNewGame: (cfg) => this.startNewGame(cfg, false),
      onPass: () => this.handleHumanPass(),
      onUndo: () => this.handleUndo(),
      onResign: () => this.handleResign(),
      onToggleMoveNumbers: () => this.toggleMoveNumbers(),
      onToggleTerritoryHint: () => this.toggleTerritoryHint(),
      onToggleCoordinates: () => {
        const next = !this.settings.get().showCoordinates;
        const updated = this.settings.update({ showCoordinates: next });
        this.scene.setCoordinatesVisible(updated.showCoordinates);
        this.ui.syncOptionsDOM(updated);
        return updated.showCoordinates;
      },
      onRequestAIHint: () => void this.handleRequestAIHint(),
      onConfirmPendingMove: () => this.confirmPendingMove(),
      onCancelPendingMove: () => this.clearPendingMove(),
      onNudgePendingMove: (dx, dy) => this.nudgePendingMove(dx, dy),
      onUpdateSettings: (patch) => this.handleSettingsUpdated(patch),
      onResetSettings: () => {
        const reset = this.settings.resetDefaults();
        this.applySettingsToScene(reset, true);
        this.refreshForbiddenOverlay();
        return reset;
      },
      onCameraPreset: (preset) => {
        this.scene.setCameraPreset(preset);
        this.ui.setCameraPresetActive(preset);
      },
      onStirBowls: () => {
        this.scene.stoneAnimator.stirBowl('black', 0.95, true);
        window.setTimeout(() => this.scene.stoneAnimator.stirBowl('white', 0.82, true), 190);
      },
      onVolumeChange: (vol) => {
        this.audio.setVolume(vol);
        const updated = this.settings.update({ soundVolume: vol });
        this.ui.syncOptionsDOM(updated);
      },
      onToggleMute: () => {
        const next = !this.audio.isMuted();
        this.audio.setMuted(next);
        const updated = this.settings.update({ soundMuted: next });
        this.ui.syncOptionsDOM(updated);
        return next;
      },
      onSaveSgf: () => void this.saveSgfFile(),
      onOpenSgf: () => void this.openSgfFile(),
      onConfirmScoring: () => this.confirmScoring(),
      onResumeFromScoring: () => this.resumeFromScoring(false),
      onEnterReview: () => this.enterReviewMode(),
      onScrubReviewMove: (idx) => this.scrubReviewMove(idx),
      onToggleFullscreen: () => void this.toggleFullscreen(),

      // Profile & Online actions
      onSaveNickname: (raw) => {
        const saved = this.profile.setNickname(raw);
        if (this.engine.config.mode === 'ai') {
          if (this.engine.config.humanColor === BLACK) this.engine.config.blackName = saved;
          else this.engine.config.whiteName = saved;
          this.ui.updateGameHeader(this.engine.config);
        }
        return saved;
      },
      onGenerateRandomNickname: () => generateDefaultNickname(),
      onEnterOnlineTab: () => {
        void this.online.startWatchingLobby().catch((err: Error) => {
          this.ui.showToast(err.message, true);
        });
      },
      onRefreshOpenRooms: () => {
        void this.online.startWatchingLobby().then(() => {
          this.online.refreshOpenRooms();
        });
      },
      onStartQuickMatch: (prefSize, gameType: GameType, omokRuleset: OmokRulesetType) => {
        this.audio.ensureReady();
        void this.online.startQuickMatch(prefSize, gameType, omokRuleset).catch((err: Error) => {
          this.ui.showToast(err.message, true);
        });
      },
      onCancelOnlineWait: () => {
        void this.online.cancelMatchmakingOrRoom();
      },
      onCreateOnlineRoom: (opts) => {
        this.audio.ensureReady();
        void this.online.createRoom(opts).catch((err: Error) => {
          this.ui.showToast(err.message, true);
        });
      },
      onJoinOnlineRoom: (code) => {
        this.audio.ensureReady();
        void this.online.joinRoom(code).catch((err: Error) => {
          this.ui.showToast(err.message, true);
        });
      },
      onGetInviteUrl: () => this.online.getInviteUrl(),
      onLeaveOnlineMatch: () => {
        this.online.leaveCurrentSession(false);
        this.clock.stop();
        this.ui.setOnlineInGameHUD(false);
        this.ui.openSetupModal(true);
        this.ui.showToast('온라인 대국방에서 퇴장했습니다.');
      },
      onSendOnlineChat: (text) => {
        if (this.engine.config.mode !== 'online') return;
        this.online.sendChat(text);
        this.ui.showChatBubble(this.engine.config.humanColor, this.profile.getNickname(), text);
      },
      onRequestOnlineRematch: () => {
        if (this.engine.config.mode !== 'online') return;
        this.online.requestRematch();
        this.ui.setRematchButtonPending();
        this.ui.showToast('상대방에게 온라인 재대국을 신청했습니다.');
      },
    });

    const initialCam = this.pickPreferredCameraPreset(defaultConfig);
    this.scene.setCameraPreset(initialCam);
    this.ui.setCameraPresetActive(initialCam);
    this.ui.updateGameHeader(defaultConfig);
    this.syncAllUI();
    this.checkUrlRoomInvite();
  }

  private createEngine(cfg: GameConfig): GoEngine | GomokuEngine {
    return cfg.gameType === 'omok' ? new GomokuEngine(cfg) : new GoEngine(cfg);
  }

  private pickPreferredCameraPreset(cfg: GameConfig): CameraPreset {
    const s = this.settings.get();
    const isPortraitMobile = isMobileOrTouchViewport() && window.innerHeight >= window.innerWidth;
    if (s.trueVerticalView || (s.autoMobileVerticalView && isPortraitMobile)) {
      return 'true_top';
    }
    if ((cfg.mode === 'ai' || cfg.mode === 'online') && cfg.humanColor === WHITE) {
      return 'white';
    }
    return 'default';
  }

  private applySettingsToScene(s: UserSettings, updateCamera: boolean): void {
    this.scene.stoneAnimator.setMotionStyle(s.stoneMotionStyle);
    this.scene.stoneAnimator.setPhysicsIntensity(s.physicsIntensity);
    this.scene.setLockVerticalRotation(s.lockVerticalRotation);
    this.scene.setTouchLoupeEnabled(s.touchLoupeEnabled);
    this.scene.setLightingTheme(s.lightingTheme);
    this.scene.setCoordinatesVisible(s.showCoordinates);
    this.audio.setVolume(s.soundVolume);
    this.audio.setMuted(s.soundMuted);

    if (updateCamera) {
      const preset = this.pickPreferredCameraPreset(this.engine.config);
      this.scene.setCameraPreset(preset);
      this.ui?.setCameraPresetActive(preset);
    }
  }

  private handleSettingsUpdated(patch: Partial<UserSettings>): UserSettings {
    const prev = this.settings.get();
    const next = this.settings.update(patch);
    const camChanged =
      prev.trueVerticalView !== next.trueVerticalView ||
      prev.autoMobileVerticalView !== next.autoMobileVerticalView;
    this.applySettingsToScene(next, camChanged);
    if (prev.showForbiddenPoints !== next.showForbiddenPoints) {
      this.refreshForbiddenOverlay();
    }
    if (prev.inputMode !== next.inputMode) {
      this.clearPendingMove();
    }
    return next;
  }

  private checkUrlRoomInvite(): void {
    try {
      const url = new URL(window.location.href);
      const roomParam = url.searchParams.get('room');
      if (!roomParam) return;

      const cleanCode = normalizeRoomCode(roomParam);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.toString());

      if (cleanCode) {
        this.ui.openOnlineJoinWithCode(cleanCode);
        void this.online.joinRoom(cleanCode).catch((err: Error) => {
          this.ui.showToast(err.message, true);
        });
      }
    } catch {
      // Ignore URL parse errors on custom file:// protocols
    }
  }

  private isHumanTurn(): boolean {
    if (this.engine.phase !== 'playing' || this.aiThinking) return false;
    if (this.engine.config.mode === 'local2p') return true;
    return this.engine.currentTurn === this.engine.config.humanColor;
  }

  private startNewGame(cfg: GameConfig, fromOnline = false): void {
    if (!fromOnline) {
      void this.online.cancelMatchmakingOrRoom();
      this.ui.setOnlineInGameHUD(false);
    }

    this.audio.ensureReady();
    this.ai.cancelPending();
    this.aiThinking = false;
    this.hintThinking = false;
    this.pendingOnlineUndo = false;
    this.showTerritoryHint = false;
    this.moveBlackWinrates = [];
    this.clearPendingMove();
    this.clearAIHints();
    this.ui.setAIHintLoading(false);
    this.ui.setHintButtonActive(false);

    this.engine = this.createEngine(cfg);
    this.deadStoneMask = new Uint8Array(cfg.boardSize * cfg.boardSize);

    this.scene.setBoardSize(cfg.boardSize);
    this.scene.stoneAnimator.syncBoardSnapshot(this.engine.board, cfg.boardSize, this.engine.captures);
    this.scene.updateMarkers(null, null, null);
    this.scene.clearTerritoryMarkers();
    this.scene.clearMoveNumbers();
    this.scene.renderOmokWinningLine(null);
    this.refreshForbiddenOverlay();

    const preferredCam = this.pickPreferredCameraPreset(cfg);
    this.scene.setCameraPreset(preferredCam);
    this.ui.setCameraPresetActive(preferredCam);

    this.ui.updateGameHeader(cfg);
    this.ui.configureReviewBar(false, 0, 0);
    this.ui.updateOnlineScoringAgreement(false, null, null);

    this.clock.configure(cfg.mainTimeSeconds, cfg.byoyomiSeconds, cfg.byoyomiPeriods);
    this.clock.startTurn(this.engine.currentTurn);

    this.audio.playCeremonialChime('start');
    window.setTimeout(() => {
      const startSide = this.engine.currentTurn === BLACK ? 'black' : 'white';
      this.scene.stoneAnimator.stirBowl(startSide, 0.72, true);
    }, 240);

    this.syncAllUI();
    void this.maybeTriggerAITurn();
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
      const statusSuffix =
        this.engine.config.mode === 'online' ? ' (상대 착수 대기)' : '';
      this.ui.setCoordStatus(`${label}${statusSuffix}`);
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
              : check.reason === 'DOUBLE_THREE'
                ? '삼삼(3·3) 금수'
                : check.reason === 'DOUBLE_FOUR'
                  ? '사사(4·4) 금수'
                  : check.reason === 'OVERLINE'
                    ? '장목(6목+) 금수'
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

      if (this.engine.config.mode === 'online') {
        this.online.sendDeadToggle(x, y, this.deadStoneMask);
      }
      return;
    }

    if (!this.isHumanTurn()) return;

    this.clearAIHints();

    const effMode = resolveEffectiveInputMode(this.settings.get().inputMode);
    if (effMode === 'instant') {
      this.clearPendingMove();
      this.commitHumanMove(x, y);
      return;
    }

    const check = this.engine.validateMove(x, y, this.engine.currentTurn);
    if (!check.valid) {
      if (check.reason && check.reason !== 'OCCUPIED') {
        this.ui.showToast(this.engine.getIllegalReasonKorean(check.reason), true);
      }
      return;
    }

    const label = coordToLabel(x, y, this.engine.size);
    if (effMode === 'double_tap') {
      const now = Date.now();
      const sameTarget =
        this.doubleTapCoord !== null && this.doubleTapCoord.x === x && this.doubleTapCoord.y === y;
      if (sameTarget && now - this.doubleTapAt < 2200) {
        this.clearPendingMove();
        this.commitHumanMove(x, y);
        return;
      }
      this.doubleTapCoord = { x, y };
      this.doubleTapAt = now;
      this.pendingCoord = { x, y };
      this.scene.setPendingMove(this.pendingCoord, this.engine.currentTurn);
      this.ui.setPendingMoveState(label, '한 번 더 탭 또는 확정');
      return;
    }

    // 'confirm' 2-step mode
    this.pendingCoord = { x, y };
    this.scene.setPendingMove(this.pendingCoord, this.engine.currentTurn);
    this.ui.setPendingMoveState(label, '착수 예정');
  }

  private nudgePendingMove(dx: number, dy: number): void {
    if (!this.pendingCoord || !this.isHumanTurn()) return;
    const maxIdx = this.engine.size - 1;
    const nx = Math.max(0, Math.min(maxIdx, this.pendingCoord.x + dx));
    const ny = Math.max(0, Math.min(maxIdx, this.pendingCoord.y + dy));
    this.pendingCoord = { x: nx, y: ny };
    this.doubleTapCoord = { x: nx, y: ny };
    this.doubleTapAt = Date.now();
    this.scene.setPendingMove(this.pendingCoord, this.engine.currentTurn);

    const check = this.engine.validateMove(nx, ny, this.engine.currentTurn);
    const label = coordToLabel(nx, ny, this.engine.size);
    const suffix = check.valid ? label : `${label} (착수 불가)`;
    this.ui.setPendingMoveState(suffix, '착수 예정');
  }

  private confirmPendingMove(): void {
    if (!this.pendingCoord || !this.isHumanTurn()) return;
    const { x, y } = this.pendingCoord;
    const check = this.engine.validateMove(x, y, this.engine.currentTurn);
    if (!check.valid) {
      this.ui.showToast(this.engine.getIllegalReasonKorean(check.reason), true);
      return;
    }
    this.clearPendingMove();
    this.commitHumanMove(x, y);
  }

  private clearPendingMove(): void {
    this.pendingCoord = null;
    this.doubleTapCoord = null;
    this.scene?.setPendingMove(null);
    this.ui?.setPendingMoveState(null);
  }

  private clearAIHints(): void {
    this.hintThinking = false;
    this.scene?.renderHintSuggestions([]);
    this.ui?.setAIHintLoading(false);
  }

  private refreshForbiddenOverlay(): void {
    if (
      this.engine instanceof GomokuEngine &&
      this.engine.phase === 'playing' &&
      this.engine.currentTurn === BLACK &&
      this.settings.get().showForbiddenPoints
    ) {
      this.scene.renderPersistentForbiddenPoints(this.engine.getForbiddenPoints());
    } else {
      this.scene.renderPersistentForbiddenPoints([]);
    }
  }

  private handleGameResultIfFinished(result: GameResult): void {
    this.clock.stop();
    this.clearPendingMove();
    this.refreshForbiddenOverlay();

    if (result.winningLine && result.winningLine.length >= 5) {
      this.scene.renderOmokWinningLine(result.winningLine);
      this.audio.playWinCelebrationChime();
    } else {
      this.audio.playCeremonialChime('finish');
    }

    this.ui.showToast(result.summaryText);
    window.setTimeout(() => {
      if (this.engine.phase === 'finished') {
        this.ui.showResultModal(result, this.engine.config);
      }
    }, 520);
  }

  private commitHumanMove(x: number, y: number): void {
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

    if (this.engine.phase === 'finished' && this.engine.result) {
      this.clock.stop();
      if (this.engine.config.mode === 'online') {
        this.online.sendMove(
          x,
          y,
          moveRes.record.color,
          moveRes.record.moveNumber,
          this.clock.getSnapshot()
        );
      }
      this.handleGameResultIfFinished(this.engine.result);
      this.syncAllUI();
      return;
    }

    this.clock.startTurn(this.engine.currentTurn);
    if (this.engine.config.mode === 'online') {
      this.online.sendMove(
        x,
        y,
        moveRes.record.color,
        moveRes.record.moveNumber,
        this.clock.getSnapshot()
      );
    }

    this.syncAllUI();
    void this.maybeTriggerAITurn();
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

    window.setTimeout(() => {
      if (
        this.engine.history.length === expectedMoveCount &&
        (this.engine.phase === 'playing' || this.engine.phase === 'finished')
      ) {
        this.scene.updateMarkers({ x, y }, color, this.engine.koPoint);
        if (this.showMoveNumbers) {
          this.scene.renderMoveNumbers(
            this.engine.history,
            this.engine.history.length,
            this.engine.board
          );
        }
      }
    }, 205);

    this.refreshForbiddenOverlay();

    if (this.showTerritoryHint && !(this.engine instanceof GomokuEngine)) {
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
        positionHashes:
          this.engine instanceof GoEngine
            ? Array.from(this.engine.positionHashes).map((h) => h.toString())
            : [],
        difficulty: this.engine.config.aiDifficulty,
        gameType: this.engine.config.gameType ?? 'baduk',
        omokRuleset: this.engine.config.omokRuleset ?? 'renju',
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
      this.executePass(aiColor, true, false);
      return;
    }

    const { x, y } = searchRes.coord;
    const res = this.engine.playMove(x, y);
    if (res.valid && res.record) {
      const blackWr = aiColor === BLACK ? searchRes.winrate : 1 - searchRes.winrate;
      res.record.winrateAfter = blackWr;
      this.moveBlackWinrates[res.record.moveNumber] = blackWr;

      this.applyMoveToScene(
        x,
        y,
        res.record.color,
        res.capturedCoords ?? [],
        res.adjacentTotalCount ?? 0
      );
      if (this.engine.result && (this.engine.phase as string) === 'finished') {
        this.handleGameResultIfFinished(this.engine.result);
        this.syncAllUI();
      } else {
        this.clock.startTurn(this.engine.currentTurn);
        this.syncAllUI();
      }
    } else {
      this.executePass(aiColor, true, false);
    }
  }

  private async handleRequestAIHint(): Promise<void> {
    if (!this.isHumanTurn() || this.hintThinking) return;
    if (this.engine.config.mode === 'online') {
      this.ui.showToast('온라인 대국에서는 공정성을 위해 AI 추천수를 사용할 수 없습니다.', true);
      return;
    }

    this.hintThinking = true;
    this.ui.setAIHintLoading(true);
    const turnColor = this.engine.currentTurn;
    const lastRecord =
      this.engine.history.length > 0 ? this.engine.history[this.engine.history.length - 1] : null;
    const hintDifficulty = Math.max(3, this.engine.config.aiDifficulty) as AIDifficulty;

    const searchRes = await this.ai.requestMove({
      board: new Uint8Array(this.engine.board),
      size: this.engine.size,
      color: turnColor,
      ruleset: this.engine.config.ruleset,
      komi: this.engine.config.komi,
      koPoint: this.engine.koPoint ? { ...this.engine.koPoint } : null,
      captures: { ...this.engine.captures },
      lastMove: lastRecord?.coord ?? null,
      opponentPassed: lastRecord !== null && lastRecord.coord === null,
      moveCount: this.engine.history.length,
      positionHashes:
        this.engine instanceof GoEngine
          ? Array.from(this.engine.positionHashes).map((h) => h.toString())
          : [],
      difficulty: hintDifficulty,
      gameType: this.engine.config.gameType ?? 'baduk',
      omokRuleset: this.engine.config.omokRuleset ?? 'renju',
      includeHints: true,
    });

    this.hintThinking = false;
    this.ui.setAIHintLoading(false);

    if (!searchRes || this.engine.phase !== 'playing' || !this.isHumanTurn()) {
      return;
    }

    const suggestions =
      searchRes.topSuggestions && searchRes.topSuggestions.length > 0
        ? searchRes.topSuggestions
        : searchRes.coord
          ? [{ coord: searchRes.coord, winrate: searchRes.winrate, visits: searchRes.simulations }]
          : [];

    if (suggestions.length === 0) {
      this.ui.showToast('AI가 한수쉼(Pass)을 권장합니다.');
      return;
    }

    this.scene.renderHintSuggestions(suggestions);
    const best = suggestions[0];
    const bestLabel = coordToLabel(best.coord.x, best.coord.y, this.engine.size);
    this.ui.showToast(
      `AI 추천수 Top ${suggestions.length}: 1순위 ${bestLabel} (승률 ${(best.winrate * 100).toFixed(1)}%)`
    );
  }

  private handleHumanPass(): void {
    if (!this.isHumanTurn()) return;
    const passColor = this.engine.currentTurn;
    const rec = this.executePass(passColor, false, false);
    if (rec && this.engine.config.mode === 'online') {
      this.online.sendPass(passColor, rec.moveNumber, this.clock.getSnapshot());
    }
    if (this.engine.phase === 'playing') {
      void this.maybeTriggerAITurn();
    }
  }

  private executePass(
    color: PlayerColor,
    byAI: boolean,
    fromRemote: boolean,
    remoteClock?: ClockSnapshot
  ) {
    const rec = this.engine.pass();
    if (!rec) return null;

    const who = color === BLACK ? '흑' : '백';
    const tag = byAI ? ' (AI)' : fromRemote ? ' (상대)' : '';
    this.ui.showToast(`${who}${tag}이(가) 한수쉼(Pass) 하였습니다.`);
    this.scene.updateMarkers(null, null, null);

    if (this.engine.phase === 'scoring') {
      this.enterScoringPhase();
    } else {
      if (remoteClock) {
        this.clock.applySnapshot(remoteClock, this.engine.currentTurn);
      } else {
        this.clock.startTurn(this.engine.currentTurn);
      }
      this.syncAllUI();
    }
    return rec;
  }

  private enterScoringPhase(): void {
    this.clock.pause();
    this.scene.clearHover();
    this.scene.stoneAnimator.snapAllToRest();
    if (this.showMoveNumbers) {
      this.scene.renderMoveNumbers(
        this.engine.history,
        this.engine.history.length,
        this.engine.board
      );
    }
    this.deadStoneMask = estimateDeadStones(this.engine.board, this.engine.size);
    if (this.engine.config.mode === 'online') {
      this.online.resetScoreAgreement();
      this.ui.updateOnlineScoringAgreement(
        true,
        this.engine.config.humanColor,
        this.online.getScoreAgreement()
      );
    } else {
      this.ui.updateOnlineScoringAgreement(false, null, null);
    }
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
    if (this.engine.config.mode === 'online') {
      this.online.sendScoreAgree(this.deadStoneMask);
      return;
    }
    this.finalizeScoringNow();
  }

  private finalizeScoringNow(): void {
    if (this.engine.phase !== 'scoring' || !(this.engine instanceof GoEngine)) return;
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

  private resumeFromScoring(fromRemote = false): void {
    if (this.engine.phase !== 'scoring' || !(this.engine instanceof GoEngine)) return;
    if (this.engine.config.mode === 'online' && !fromRemote) {
      this.online.sendScoreResume();
    }
    this.engine.resumePlayingFromScoring();
    this.deadStoneMask.fill(0);
    this.scene.stoneAnimator.updateDeadMaskVisuals(null);
    if (!this.showTerritoryHint) {
      this.scene.clearTerritoryMarkers();
    }
    this.clock.startTurn(this.engine.currentTurn);
    this.syncAllUI();
    void this.maybeTriggerAITurn();
  }

  private handleUndo(): void {
    if (this.engine.phase !== 'playing' || this.aiThinking || this.engine.history.length === 0) {
      return;
    }

    if (this.engine.config.mode === 'online') {
      if (this.pendingOnlineUndo) {
        this.ui.showToast('이미 상대방의 무르기 응답을 기다리고 있습니다.');
        return;
      }
      // If opponent hasn't replied to my last move yet, undo 1 ply; if it's already my turn again, undo 2 plies
      const isMyTurn = this.engine.currentTurn === this.engine.config.humanColor;
      const steps = isMyTurn && this.engine.history.length >= 2 ? 2 : 1;
      this.pendingOnlineUndo = true;
      this.online.requestUndo(steps);
      this.ui.showToast(`상대방에게 ${steps}수 무르기를 요청했습니다.`);
      return;
    }

    let steps = 1;
    if (this.engine.config.mode === 'ai') {
      steps = this.engine.history.length >= 2 ? 2 : 1;
    }

    if (this.performUndoSteps(steps)) {
      this.ui.showToast(`${steps}수 무르기 완료`);
      void this.maybeTriggerAITurn();
    }
  }

  private performUndoSteps(steps: number, syncedClock?: ClockSnapshot): boolean {
    if (!this.engine.undo(steps)) return false;

    this.clearPendingMove();
    this.clearAIHints();
    this.scene.renderOmokWinningLine(null);
    this.audio.playStonePickup('left', false);
    this.scene.stoneAnimator.syncBoardSnapshot(
      this.engine.board,
      this.engine.size,
      this.engine.captures
    );
    const last =
      this.engine.history.length > 0 ? this.engine.history[this.engine.history.length - 1] : null;
    this.scene.updateMarkers(last?.coord ?? null, last?.color ?? null, this.engine.koPoint);
    this.refreshForbiddenOverlay();

    if (this.showMoveNumbers) {
      this.scene.renderMoveNumbers(this.engine.history, this.engine.history.length, this.engine.board);
    }
    if (this.showTerritoryHint && !(this.engine instanceof GomokuEngine)) {
      this.refreshTerritoryHintOverlay();
    }

    if (syncedClock) {
      this.clock.applySnapshot(syncedClock, this.engine.currentTurn);
    } else {
      this.clock.startTurn(this.engine.currentTurn);
    }
    this.syncAllUI();
    return true;
  }

  private handleResign(): void {
    if (this.engine.phase !== 'playing' || this.aiThinking) return;
    const resigningColor =
      this.engine.config.mode === 'ai' || this.engine.config.mode === 'online'
        ? this.engine.config.humanColor
        : this.engine.currentTurn;

    if (this.engine.config.mode === 'online') {
      this.online.sendResign(resigningColor);
    }

    this.clock.stop();
    const res = this.engine.resign(resigningColor);
    this.audio.playCeremonialChime('finish');
    this.syncAllUI();
    this.ui.showResultModal(res, this.engine.config);
  }

  private buildSyncSnapshot(): SyncSnapshotPayload | null {
    const roomCode = this.online.getActiveRoomCode();
    if (!roomCode || this.engine.config.mode !== 'online') return null;

    const deadIndices: number[] = [];
    for (let i = 0; i < this.deadStoneMask.length; i++) {
      if (this.deadStoneMask[i]) deadIndices.push(i);
    }

    const phase =
      this.engine.phase === 'scoring'
        ? 'scoring'
        : this.engine.phase === 'finished'
          ? 'finished'
          : 'playing';

    return {
      roomCode,
      moves: this.engine.history.map((m) => ({
        color: m.color,
        coord: m.coord ? { ...m.coord } : null,
      })),
      phase,
      deadIndices,
      scoreAgreement: this.online.getScoreAgreement(),
      clock: this.clock.getSnapshot(),
    };
  }

  private applySyncSnapshot(snap: SyncSnapshotPayload): void {
    if (this.engine.config.mode !== 'online') return;
    if (snap.moves.length <= this.engine.history.length) return;

    const cfg = { ...this.engine.config };
    this.engine = this.createEngine(cfg);
    this.clearPendingMove();
    this.clearAIHints();
    this.scene.renderOmokWinningLine(null);
    for (const m of snap.moves) {
      if (m.coord === null) {
        this.engine.pass();
      } else {
        this.engine.playMove(m.coord.x, m.coord.y);
      }
    }

    this.scene.stoneAnimator.syncBoardSnapshot(
      this.engine.board,
      this.engine.size,
      this.engine.captures
    );
    const last =
      this.engine.history.length > 0 ? this.engine.history[this.engine.history.length - 1] : null;
    this.scene.updateMarkers(last?.coord ?? null, last?.color ?? null, this.engine.koPoint);
    this.refreshForbiddenOverlay();

    if (snap.phase === 'scoring') {
      this.engine.phase = 'scoring';
      this.deadStoneMask = new Uint8Array(this.engine.size * this.engine.size);
      for (const idx of snap.deadIndices) {
        if (idx >= 0 && idx < this.deadStoneMask.length) this.deadStoneMask[idx] = 1;
      }
      this.clock.applySnapshot(snap.clock, null);
      this.refreshScoringPreview();
    } else if (snap.phase === 'playing') {
      this.clock.applySnapshot(snap.clock, this.engine.currentTurn);
    }
    this.syncAllUI();
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
    this.clearPendingMove();
    this.clearAIHints();
    this.engine.phase = 'review';
    this.scene.clearTerritoryMarkers();
    this.scene.renderPersistentForbiddenPoints([]);
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

    this.ui.configureReviewBar(
      true,
      this.reviewMoveIndex,
      this.engine.history.length,
      this.moveBlackWinrates
    );
    this.ui.updatePlayersStatus({
      turn: snap.nextTurn,
      phase: this.engine.phase,
      captures: snap.captures,
      aiThinking: false,
      moveCount: this.engine.history.length,
      mode: this.engine.config.mode,
      humanColor: this.engine.config.humanColor,
      gameType: this.engine.config.gameType,
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
      void this.online.cancelMatchmakingOrRoom();
      this.ui.setOnlineInGameHUD(false);
      this.ai.cancelPending();
      this.aiThinking = false;
      this.clock.stop();

      const cfg: GameConfig = {
        ...this.engine.config,
        boardSize: parsed.boardSize,
        komi: parsed.komi,
        ruleset: parsed.ruleset,
        gameType: parsed.gameType,
        omokRuleset: parsed.omokRuleset,
        handicap: 0,
        mode: 'local2p',
        mainTimeSeconds: 0,
        byoyomiSeconds: 0,
        byoyomiPeriods: 0,
        blackName: parsed.blackName || '흑 (기보)',
        whiteName: parsed.whiteName || '백 (기보)',
      };

      this.moveBlackWinrates = [];
      this.scene.renderOmokWinningLine(null);
      this.engine = this.createEngine(cfg);
      if (this.engine instanceof GoEngine) {
        for (const pt of parsed.setupBlack) this.engine.setCustomSetupStone(pt.x, pt.y, BLACK);
        for (const pt of parsed.setupWhite) this.engine.setCustomSetupStone(pt.x, pt.y, WHITE);
      } else {
        for (const pt of parsed.setupBlack) this.engine.board[pt.y * cfg.boardSize + pt.x] = BLACK;
        for (const pt of parsed.setupWhite) this.engine.board[pt.y * cfg.boardSize + pt.x] = WHITE;
      }

      for (const m of parsed.moves) {
        this.engine.currentTurn = m.color;
        if (m.coord === null) {
          this.engine.pass();
          if (this.engine.phase === 'scoring') {
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
      mode: this.engine.config.mode,
      humanColor: this.engine.config.humanColor,
      gameType: this.engine.config.gameType,
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new BadukApp();
});
