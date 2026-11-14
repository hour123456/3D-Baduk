import {
  BLACK,
  WHITE,
  AIDifficulty,
  BoardSize,
  GameConfig,
  GamePhase,
  GameResult,
  GameType,
  OmokRulesetType,
  PlayerColor,
  RulesetType,
  ScoreBreakdown,
} from '../rules/types';
import {
  AdminBanEntry,
  CreateRoomOptions,
  OnlineScoreAgreementState,
  OnlineSessionPhase,
  OnlineSessionRole,
  OnlineTransportStatus,
  PresenceStats,
  QuickMatchSizePref,
  RoomSummary,
} from '../online/types';
import { formatBanDurationRemaining } from '../online/adminSecurity';
import { UrgentCountdownState } from '../rules/clock';
import {
  BoardGrainIntensity,
  GridLineContrast,
  LightingTheme,
  PhysicsIntensity,
  PlacementInputMode,
  resolveEffectiveUiLayout,
  StoneMotionStyle,
  UILayoutMode,
  UserSettings,
  VisualQuality,
} from '../settings/SettingsManager';
import { CameraPreset } from '../scene/SceneManager';
import { TutorialLesson, TutorialStep } from '../tutorial/TutorialCurriculum';

export interface UIActions {
  onStartNewGame: (config: GameConfig) => void;
  onPass: () => void;
  onUndo: () => void;
  onResign: () => void;
  onToggleMoveNumbers: () => boolean;
  onToggleTerritoryHint: () => boolean;
  onToggleCoordinates: () => boolean;
  onRequestAIHint: () => void;
  onConfirmPendingMove: () => void;
  onCancelPendingMove: () => void;
  onNudgePendingMove: (dx: number, dy: number) => void;
  onUpdateSettings: (patch: Partial<UserSettings>) => UserSettings;
  onResetSettings: () => UserSettings;
  onCameraPreset: (preset: CameraPreset) => void;
  onStirBowls: () => void;
  onVolumeChange: (vol: number) => void;
  onToggleMute: () => boolean;
  onSaveSgf: () => void;
  onOpenSgf: () => void;
  onConfirmScoring: () => void;
  onResumeFromScoring: () => void;
  onEnterReview: () => void;
  onScrubReviewMove: (moveIdx: number) => void;
  onToggleFullscreen: () => void;

  // Profile & Online Multiplayer actions
  onSaveNickname: (nickname: string) => string;
  onGenerateRandomNickname: () => string;
  onEnterOnlineTab: () => void;
  onRefreshOpenRooms: () => void;
  onStartQuickMatch: (
    preferredSize: QuickMatchSizePref,
    gameType: GameType,
    omokRuleset: OmokRulesetType
  ) => void;
  onCancelOnlineWait: () => void;
  onCreateOnlineRoom: (options: CreateRoomOptions) => void;
  onJoinOnlineRoom: (roomCode: string, password?: string) => void;
  onSpectateOnlineRoom: (roomCode: string, password?: string) => void;
  onGetInviteUrl: () => string;
  isOwnRoom?: (room: RoomSummary) => boolean;
  onCloseOwnRoom?: (roomCode: string) => void;
  onLeaveOnlineMatch: () => void;
  onSendOnlineChat: (text: string) => void;
  onRequestOnlineRematch: () => void;

  // Beginner Tutorial & Learning actions
  onOpenTutorialModal: () => void;
  onStartTutorialLesson: (lessonId: string) => void;
  onToggleTutorialHint: () => void;
  onRetryTutorialStep: () => void;
  onTutorialNextStep: () => void;
  onExitTutorial: () => void;
}

const AI_LEVEL_DESCRIPTIONS: Record<AIDifficulty, string> = {
  1: 'Lv.1 입문 — 바둑 규칙과 착수·따내기를 부담 없이 익히는 완전 입문용 난이도입니다.',
  2: 'Lv.2 초급 — 단수·활로 등 기초 감각 중심으로 두어 초심자도 쉽게 즐길 수 있는 대국입니다.',
  3: 'Lv.3 중급 — 기본 포석과 형세 감각을 갖춘 표준 난이도로, 일반인도 편하게 즐기고 승리할 수 있습니다.',
  4: 'Lv.4 고급 — 축·환격·양단수·맥점을 동원한 치열한 수읽기와 공격적인 포석·전투를 펼칩니다.',
  5: 'Lv.5 마스터 — 최고 수준의 정밀 MCTS 수읽기와 냉철한 수비·전투 판단으로 빈틈없는 승부를 구사합니다.',
};

const OMOK_AI_LEVEL_DESCRIPTIONS: Record<AIDifficulty, string> = {
  1: 'Lv.1 입문 — 오목 규칙과 5목 만들기를 부담 없이 익히는 완전 입문용 난이도입니다.',
  2: 'Lv.2 초급 — 기본적인 3·4 방어 등 기초 감각 중심의 쉽고 가벼운 연습 대국입니다.',
  3: 'Lv.3 중급 — 기본 공방 감각을 갖춘 표준 난이도로, 일반인도 편하게 즐기고 승리할 수 있습니다.',
  4: 'Lv.4 고급 — 날카로운 수읽기와 VCF(연속 4수 필승) 기반의 공격적인 포석·전투를 구사합니다.',
  5: 'Lv.5 마스터 — 최고 수준의 정밀 수읽기와 공수 VCF 완급 조절로 냉철한 최상급 승부를 펼칩니다.',
};

export const AI_LEVEL_NAMES: Record<AIDifficulty, string> = {
  1: '입문',
  2: '초급',
  3: '중급',
  4: '고급',
  5: '마스터',
};

const QUICK_EMOTES: string[] = [
  '반갑습니다. 잘 부탁드립니다!',
  '좋은 수네요!',
  '잠시 장고하겠습니다.',
  '아차, 실수했네요!',
  '수고하셨습니다. 좋은 대국이었습니다!',
];

const SPECTATOR_QUICK_EMOTES: string[] = [
  '명국 기대됩니다!',
  '좋은 수네요!',
  '형세가 팽팽합니다.',
  '멋진 맥점입니다!',
  '긴장감 넘치네요!',
];

export function parseTimePreset(preset: string): {
  mainTimeSeconds: number;
  byoyomiSeconds: number;
  byoyomiPeriods: number;
} {
  switch (preset) {
    case '5m_30s':
      return { mainTimeSeconds: 300, byoyomiSeconds: 30, byoyomiPeriods: 3 };
    case '10m_30s':
      return { mainTimeSeconds: 600, byoyomiSeconds: 30, byoyomiPeriods: 3 };
    case '20m_40s':
      return { mainTimeSeconds: 1200, byoyomiSeconds: 40, byoyomiPeriods: 3 };
    case '0m_30s':
      return { mainTimeSeconds: 0, byoyomiSeconds: 30, byoyomiPeriods: 3 };
    case 'unlimited':
      return { mainTimeSeconds: 0, byoyomiSeconds: 0, byoyomiPeriods: 0 };
    default:
      return { mainTimeSeconds: 600, byoyomiSeconds: 30, byoyomiPeriods: 3 };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class UIManager {
  private root: HTMLElement;
  private actions: UIActions;
  private currentNickname: string;
  private settings: UserSettings;

  // Draft setup form state (Offline)
  private draftMode: 'ai' | 'local2p' | 'online' = 'ai';
  private draftGameType: GameType = 'baduk';
  private draftOmokRuleset: OmokRulesetType = 'renju';
  private draftDifficulty: AIDifficulty = 3;
  private draftColorChoice: 'black' | 'white' | 'random' = 'black';
  private draftSize: BoardSize = 19;
  private draftRuleset: RulesetType = 'korean';
  private draftHandicap = 0;
  private draftKomi = 6.5;
  private draftTimePreset = '10m_30s';

  // Draft setup form state (Online)
  private onlineSubTab: 'quick' | 'create' | 'join' = 'quick';
  private qmGameType: GameType = 'baduk';
  private qmOmokRuleset: OmokRulesetType = 'renju';
  private qmSizePref: QuickMatchSizePref = 'any';
  private roomVis: 'public' | 'private' = 'public';
  private roomGameType: GameType = 'baduk';
  private roomOmokRuleset: OmokRulesetType = 'renju';
  private roomSize: BoardSize = 19;
  private roomRuleset: RulesetType = 'korean';
  private roomHandicap = 0;
  private roomKomi = 6.5;
  private roomTimePreset = '10m_30s';
  private roomHostColor: 'black' | 'white' | 'random' = 'random';
  private roomFilter: 'all' | 'waiting' | 'in_game' = 'all';
  private cachedOpenRooms: RoomSummary[] = [];

  private onlineSessionRole: OnlineSessionRole = 'none';
  private currentOnlineRoomCode = '';
  private currentOnlineMyColor?: PlayerColor;
  private currentOnlinePingMs?: number;
  private currentSpectatorCount = 0;
  private chatUnreadCount = 0;
  private pendingPasswordPrompt: { action: 'join' | 'spectate'; roomCode: string } | null = null;

  private qmElapsedTimer: number | null = null;
  private qmStartTs = 0;
  private bubbleTimers: { [K in PlayerColor]?: number } = {};

  // DOM Elements
  private brandTitleEl!: HTMLElement;
  private metaBadgeEl!: HTMLElement;
  private coordBadgeEl!: HTMLElement;
  private onlineHudPillEl!: HTMLElement;
  private onlineHudTextEl!: HTMLElement;
  private leaveOnlineBtn!: HTMLButtonElement;
  private topNickLabelEl!: HTMLElement;

  private blackCardEl!: HTMLElement;
  private whiteCardEl!: HTMLElement;
  private blackNameEl!: HTMLElement;
  private whiteNameEl!: HTMLElement;
  private blackSubEl!: HTMLElement;
  private whiteSubEl!: HTMLElement;
  private blackTurnPill!: HTMLElement;
  private whiteTurnPill!: HTMLElement;
  private blackCapturesEl!: HTMLElement;
  private whiteCapturesEl!: HTMLElement;
  private blackClockEl!: HTMLElement;
  private whiteClockEl!: HTMLElement;
  private blackBubbleEl!: HTMLElement;
  private whiteBubbleEl!: HTMLElement;

  private scoringBannerEl!: HTMLElement;
  private scoringTallyEl!: HTMLElement;
  private confirmScoreBtn!: HTMLButtonElement;
  private scoringDescEl!: HTMLElement;

  private onlinePromptBannerEl!: HTMLElement;
  private onlinePromptTextEl!: HTMLElement;
  private promptAcceptHandler: (() => void) | null = null;
  private promptDeclineHandler: (() => void) | null = null;

  private reviewBarEl!: HTMLElement;
  private reviewSliderEl!: HTMLInputElement;
  private reviewLabelEl!: HTMLElement;
  private reviewChartCanvasEl!: HTMLCanvasElement;
  private reviewWinrateLabelEl!: HTMLElement;

  private pendingMoveBarEl!: HTMLElement;
  private pendingCoordEl!: HTMLElement;

  private chatPopoverEl!: HTMLElement;
  private chatToggleBtn!: HTMLButtonElement;
  private chatInputEl!: HTMLInputElement;
  private chatRoleBannerEl!: HTMLElement;
  private chatMessagesListEl!: HTMLElement;
  private chatUnreadBadgeEl!: HTMLElement;
  private quickEmotesGridEl!: HTMLElement;

  private passBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private resignBtn!: HTMLButtonElement;
  private aiHintBtn!: HTMLButtonElement;
  private hintBtn!: HTMLButtonElement;
  private moveNumBtn!: HTMLButtonElement;
  private coordsBtn!: HTMLButtonElement;
  private showResultBtn!: HTMLButtonElement;
  private resumeScoreBtn!: HTMLButtonElement;
  private camPresetBtns: HTMLButtonElement[] = [];

  private setupModalEl!: HTMLElement;
  private setupNickInputEl!: HTMLInputElement;
  private nickModalEl!: HTMLElement;
  private nickModalInputEl!: HTMLInputElement;
  private passwordModalEl!: HTMLElement;
  private passwordModalTitleEl!: HTMLElement;
  private passwordModalDescEl!: HTMLElement;
  private passwordModalErrorEl!: HTMLElement;
  private passwordModalInputEl!: HTMLInputElement;

  private webPresenceBadgeEl!: HTMLElement;
  private webPresenceCountEl!: HTMLElement;
  private webPresenceDetailEl!: HTMLElement;

  private onlineStatusDotEl!: HTMLElement;
  private onlineStatusTextEl!: HTMLElement;
  private qmIdleBoxEl!: HTMLElement;
  private qmSearchingBoxEl!: HTMLElement;
  private qmTimerTextEl!: HTMLElement;
  private createFormBoxEl!: HTMLElement;
  private roomPasswordWrapEl!: HTMLElement;
  private roomPasswordInputEl!: HTMLInputElement;
  private waitingRoomBoxEl!: HTMLElement;
  private waitingRoomCodeEl!: HTMLElement;
  private waitingRoomMetaEl!: HTMLElement;
  private openRoomsListEl!: HTMLElement;
  private joinCodeInputEl!: HTMLInputElement;
  private joiningStatusMsgEl!: HTMLElement;

  private resultModalEl!: HTMLElement;
  private resultBodyEl!: HTMLElement;
  private rematchResultBtn!: HTMLButtonElement;
  private optionsModalEl!: HTMLElement;
  private toastContainerEl!: HTMLElement;
  private hasStartedOnce = false;

  // Byoyomi 10s urgent visual alert
  private byoyomiPulseEl!: HTMLElement;
  private byoyomiBannerEl!: HTMLElement;
  private byoyomiBannerNumEl!: HTMLElement;
  private byoyomiBannerLabelEl!: HTMLElement;
  private byoyomiBannerSubEl!: HTMLElement;
  private lastBannerCount: number | null = null;

  // Beginner Tutorial Coach & Selector
  private tutorialCoachEl!: HTMLElement;
  private tutorialCoachTitleEl!: HTMLElement;
  private tutorialCoachStepEl!: HTMLElement;
  private tutorialCoachTextEl!: HTMLElement;
  private tutorialCoachFeedbackEl!: HTMLElement;
  private tutorialCoachHintEl!: HTMLElement;
  private tutorialNextBtn!: HTMLButtonElement;
  private tutorialModalEl!: HTMLElement;
  private tutorialLessonGridEl!: HTMLElement;
  private tutorialProgressSummaryEl!: HTMLElement;

  // Account/IP Ban Blocker Modal
  private banModalEl!: HTMLElement;
  private banModalBodyEl!: HTMLElement;

  // Dedicated Mobile HUD Elements
  private mobTitleEl!: HTMLElement;
  private mobOnlineBadgeEl!: HTMLElement;
  private mobLeaveOnlineBtn!: HTMLButtonElement;
  private mobOppCardEl!: HTMLElement;
  private mobOppDotEl!: HTMLElement;
  private mobOppNameEl!: HTMLElement;
  private mobOppCapEl!: HTMLElement;
  private mobOppClockEl!: HTMLElement;
  private mobSelfCardEl!: HTMLElement;
  private mobSelfDotEl!: HTMLElement;
  private mobSelfNameEl!: HTMLElement;
  private mobSelfCapEl!: HTMLElement;
  private mobSelfClockEl!: HTMLElement;
  private mobCoordBadgeEl!: HTMLElement;
  private mobPassBtn!: HTMLButtonElement;
  private mobUndoBtn!: HTMLButtonElement;
  private mobAiHintBtn!: HTMLButtonElement;
  private mobChatBtn!: HTMLButtonElement;
  private mobChatBadgeEl!: HTMLElement;
  private mobMoreSheetEl!: HTMLElement;
  private mobSheetCoordsBtn!: HTMLButtonElement;
  private mobSheetNumsBtn!: HTMLButtonElement;
  private mobSheetHintBtn!: HTMLButtonElement;
  private mobSheetResignBtn!: HTMLButtonElement;
  private mobSheetResultBtn!: HTMLButtonElement;
  private lastHudConfig?: GameConfig;
  private lastHudStatus?: {
    turn: PlayerColor;
    phase: GamePhase;
    captures: { black: number; white: number };
    aiThinking: boolean;
    moveCount: number;
    mode?: 'ai' | 'local2p' | 'online';
    humanColor?: PlayerColor;
    gameType?: GameType;
  };

  constructor(
    root: HTMLElement,
    initialNickname: string,
    initialSettings: UserSettings,
    actions: UIActions
  ) {
    this.root = root;
    this.currentNickname = initialNickname;
    this.settings = { ...initialSettings };
    this.actions = actions;
    this.buildDOM();
  }

  private buildDOM(): void {
    const isElectronApp = typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
    const emoteButtonsHtml = QUICK_EMOTES.map(
      (txt) => `<button class="emote-chip" data-emote="${escapeHtml(txt)}">${escapeHtml(txt)}</button>`
    ).join('');

    this.root.innerHTML = `
      <!-- Web-Only Live Concurrent User Presence Badge -->
      <div class="web-live-users-badge interactive${isElectronApp ? ' hidden' : ''}" id="web-live-users-badge" title="웹 실시간 접속자 수">
        <span class="presence-pulse-dot"></span>
        <span class="presence-main">실시간 접속 <strong id="web-presence-count">1</strong>명</span>
        <span class="presence-detail hidden" id="web-presence-detail"></span>
      </div>

      <!-- Top Header -->
      <div>
        <div class="top-bar">
          <div class="brand-cluster interactive">
            <div class="brand-seal">手談</div>
            <span class="brand-title" id="ui-brand-title">수담 3D 바둑</span>
            <span class="game-meta-badge" id="ui-meta-badge">19줄 · 한국식 · 덤 6.5집</span>
            <span class="coord-badge" id="ui-coord-badge">대기 중</span>
            <span class="online-hud-pill hidden" id="ui-online-pill">
              <span class="conn-dot"></span>
              <span id="ui-online-pill-text">온라인 대국</span>
            </span>
            <button class="btn btn-sm btn-danger hidden" id="btn-leave-online" title="온라인 대국방 나가기">방 나가기</button>
          </div>

          <div class="top-actions interactive">
            <button class="btn btn-sm nick-pill-btn" id="btn-profile-nick" title="내 닉네임 변경">
              <span class="nick-dot"></span>
              <span id="top-nick-label">${escapeHtml(this.currentNickname)}</span>
              <span class="nick-edit-tag">닉네임</span>
            </button>
            <div class="divider-v"></div>
            <button class="btn btn-sm" data-cam="default" title="흑 정면 기본 시점">기본뷰</button>
            <button class="btn btn-sm" data-cam="white" title="백 정면 시점">백시점</button>
            <button class="btn btn-sm" data-cam="top" title="원근 조감도 시점">조감도</button>
            <button class="btn btn-sm" data-cam="true_top" title="원근 왜곡 없는 90° 정밀 수직뷰">수직뷰</button>
            <button class="btn btn-sm" data-cam="cinema" title="입체 사선 시점">입체뷰</button>
            <div class="divider-v"></div>
            <button class="btn btn-sm" id="btn-stir-bowls" title="바둑통 속 바둑돌 잘그락 소리 듣기">바둑통 잘그락</button>
            <div class="volume-wrap">
              <button class="btn btn-sm" id="btn-mute" title="음소거 전환">음향</button>
              <input type="range" class="volume-slider" id="slider-volume" min="0" max="100" value="85" />
            </div>
            <div class="divider-v"></div>
            <button class="btn btn-sm btn-gold" id="btn-open-setup">새 대국 · 온라인</button>
            <button class="btn btn-sm btn-tutorial-nav" id="btn-open-tutorial" title="초보자를 위한 바둑·오목 입문 튜토리얼">입문 학습</button>
            <button class="btn btn-sm" id="btn-open-options" title="조명 밝기 · 반상 선명도 · 모션 · 모바일 UI 설정">⚙ 옵션</button>
            <button class="btn btn-sm" id="btn-fullscreen" title="전체화면 (F11)">전체화면</button>
          </div>
        </div>

        <!-- Dedicated Mobile Top Bar (Shown only when uiLayout = mobile) -->
        <div class="mobile-top-bar mobile-only interactive" id="mobile-top-bar">
          <div class="mob-top-left">
            <span class="mob-brand-seal">手談</span>
            <span class="mob-title" id="mob-ui-title">수담 3D</span>
            <span class="mob-online-badge hidden" id="mob-online-badge">온라인</span>
            <button class="btn btn-sm btn-danger hidden" id="mob-btn-leave-online">나가기</button>
          </div>
          <div class="mob-top-actions">
            <button class="btn btn-sm btn-tutorial-nav" id="mob-btn-tutorial">학습</button>
            <button class="btn btn-sm" id="mob-btn-vview" data-cam="true_top">수직뷰</button>
            <button class="btn btn-sm btn-gold" id="mob-btn-setup">대국</button>
            <button class="btn btn-sm" id="mob-btn-options">⚙</button>
          </div>
        </div>

        <!-- Dedicated Mobile Slim Opponent Strip -->
        <div class="mobile-player-strip opp mobile-only" id="mobile-opponent-bar">
          <div class="mob-player-left">
            <span class="stone-icon white mob-dot" id="mob-opp-dot"></span>
            <span class="mob-player-name" id="mob-opp-name">백 대국자</span>
          </div>
          <div class="mob-player-right">
            <span class="mob-cap-pill">사석 <strong id="mob-opp-cap">0</strong></span>
            <span class="mob-clock-pill" id="mob-opp-clock">무제한</span>
          </div>
        </div>

        <!-- Black & White Player Cards -->
        <div class="players-hud-row">
          <div class="player-col-wrap">
            <div class="player-card" id="card-white">
              <div class="player-header">
                <div class="stone-icon white"></div>
                <div class="player-title-box">
                  <div class="player-name" id="name-white">백 대국자</div>
                  <div class="player-sub" id="sub-white">덤 6.5집</div>
                </div>
                <span class="turn-pill" id="pill-white">차례</span>
              </div>
              <div class="player-stats">
                <span class="stat-captures">사석 <strong id="cap-white">0</strong></span>
                <span class="stat-clock" id="clock-white">무제한</span>
              </div>
            </div>
            <div class="chat-bubble hidden" id="bubble-white"></div>
          </div>

          <div class="center-banner-slot">
            <div class="online-prompt-banner hidden" id="online-prompt-banner">
              <span id="online-prompt-text">상대방 요청</span>
              <button class="btn btn-sm btn-gold" id="btn-prompt-accept">수락</button>
              <button class="btn btn-sm btn-danger" id="btn-prompt-decline">거절</button>
            </div>

            <div class="scoring-banner hidden" id="scoring-banner">
              <div class="scoring-banner-text">
                <h4>사석 지정 및 계가 합의</h4>
                <p id="scoring-desc-text">반상 위의 죽은 돌(사석)을 클릭해 지정·해제한 뒤 계가를 확정하세요.</p>
              </div>
              <div class="scoring-live-tally" id="scoring-live-tally">흑 0 vs 백 6.5</div>
              <button class="btn btn-gold" id="btn-confirm-score">계가 확정</button>
              <button class="btn" id="btn-resume-play">대국 재개</button>
            </div>
          </div>

          <div class="player-col-wrap">
            <div class="player-card active-turn" id="card-black">
              <div class="player-header">
                <div class="stone-icon black"></div>
                <div class="player-title-box">
                  <div class="player-name" id="name-black">흑 대국자</div>
                  <div class="player-sub" id="sub-black">선번</div>
                </div>
                <span class="turn-pill" id="pill-black">차례</span>
              </div>
              <div class="player-stats">
                <span class="stat-captures">사석 <strong id="cap-black">0</strong></span>
                <span class="stat-clock" id="clock-black">무제한</span>
              </div>
            </div>
            <div class="chat-bubble hidden" id="bubble-black"></div>
          </div>
        </div>
      </div>

      <!-- Bottom Chat Popover, Review Scrubber & Control Dock -->
      <div class="bottom-area">
        <div class="chat-popover interactive hidden" id="chat-popover">
          <div class="chat-popover-header">
            <span class="chat-role-banner" id="chat-role-banner">🔒 대국자 전용 채팅 (관전자 비공개)</span>
            <button class="btn btn-sm" id="btn-close-chat">닫기</button>
          </div>
          <div class="chat-messages-list" id="chat-messages-list">
            <div class="chat-empty-hint">대화 내용이 여기에 표시됩니다.</div>
          </div>
          <div class="quick-emotes-grid" id="quick-emotes-grid">${emoteButtonsHtml}</div>
          <div class="chat-input-row">
            <input
              type="text"
              class="text-input"
              id="inp-online-chat"
              maxlength="120"
              placeholder="수담 메시지 입력 (Enter 전송)"
            />
            <button class="btn btn-gold" id="btn-send-chat">전송</button>
          </div>
        </div>

        <div class="hidden" id="pending-move-bar">
          <span class="pending-coord-pill" id="pending-move-coord">착수 예정: --</span>
          <div class="pending-nudge-pad" aria-label="1칸 미세 이동">
            <button class="nudge-btn" id="btn-nudge-left" type="button" title="왼쪽 1칸">◀</button>
            <button class="nudge-btn" id="btn-nudge-up" type="button" title="위쪽 1칸">▲</button>
            <button class="nudge-btn" id="btn-nudge-down" type="button" title="아래쪽 1칸">▼</button>
            <button class="nudge-btn" id="btn-nudge-right" type="button" title="오른쪽 1칸">▶</button>
          </div>
          <div class="pending-actions">
            <button class="btn-cancel-move" id="btn-pending-cancel" type="button">취소</button>
            <button class="btn-confirm-move" id="btn-pending-confirm" type="button">착수 확정</button>
          </div>
        </div>

        <div class="review-bar interactive hidden" id="review-bar">
          <button class="btn btn-sm" id="rev-first" title="초수 전으로">|&lt;</button>
          <button class="btn btn-sm" id="rev-prev" title="이전 수">&lt;</button>
          <input type="range" class="review-slider" id="rev-slider" min="0" max="0" value="0" />
          <button class="btn btn-sm" id="rev-next" title="다음 수">&gt;</button>
          <button class="btn btn-sm" id="rev-last" title="마지막 수">&gt;|</button>
          <span class="review-label" id="rev-label">0 / 0수</span>
          <div class="review-chart-wrap hidden" id="rev-chart-wrap">
            <div class="review-chart-caption">
              <span>흑 기준 AI 기대승률 추이 (Review)</span>
              <span id="rev-winrate-label">--%</span>
            </div>
            <canvas id="rev-winrate-chart" width="380" height="46"></canvas>
          </div>
        </div>

        <div class="bottom-dock interactive">
          <button class="btn" id="btn-pass">한수쉼 (Pass)</button>
          <button class="btn" id="btn-undo">무르기</button>
          <button class="btn btn-danger" id="btn-resign">기권</button>
          <div class="divider-v"></div>
          <button class="btn hidden" id="btn-chat-toggle">
            <span id="chat-toggle-label">수담 인사·채팅</span>
            <span class="chat-unread-badge hidden" id="chat-unread-badge">0</span>
          </button>
          <button class="btn btn-ai-hint" id="btn-ai-hint" title="AI가 분석한 최선 추천수 Top 3 보기">AI 추천수</button>
          <button class="btn" id="btn-territory-hint">형세·집 보기</button>
          <button class="btn" id="btn-move-nums">수순 번호</button>
          <button class="btn btn-active" id="btn-coords">좌표 눈금</button>
          <div class="divider-v"></div>
          <button class="btn" id="btn-save-sgf">기보 저장(SGF)</button>
          <button class="btn" id="btn-open-sgf">기보 열기</button>
          <button class="btn btn-gold hidden" id="btn-show-result">계가 결과표</button>
        </div>

        <!-- Dedicated Mobile Slim Self Strip -->
        <div class="mobile-player-strip self mobile-only" id="mobile-self-bar">
          <div class="mob-player-left">
            <span class="stone-icon black mob-dot" id="mob-self-dot"></span>
            <span class="mob-player-name" id="mob-self-name">흑 대국자</span>
            <span class="mob-coord-badge" id="mob-coord-badge">대기</span>
          </div>
          <div class="mob-player-right">
            <span class="mob-cap-pill">사석 <strong id="mob-self-cap">0</strong></span>
            <span class="mob-clock-pill" id="mob-self-clock">무제한</span>
          </div>
        </div>

        <!-- Dedicated Mobile Thumb-Friendly 5-Button Dock -->
        <div class="mobile-bottom-dock mobile-only interactive" id="mobile-bottom-dock">
          <button class="btn mob-dock-btn" id="mob-btn-pass">한수쉼</button>
          <button class="btn mob-dock-btn" id="mob-btn-undo">무르기</button>
          <button class="btn mob-dock-btn btn-ai-hint" id="mob-btn-ai-hint">AI추천</button>
          <button class="btn mob-dock-btn hidden" id="mob-btn-chat">
            <span>채팅</span>
            <span class="chat-unread-badge hidden" id="mob-chat-unread-badge">0</span>
          </button>
          <button class="btn mob-dock-btn" id="mob-btn-more">더보기 ▴</button>
        </div>

        <!-- Mobile Slide-up More Action Sheet -->
        <div class="mobile-more-sheet mobile-only interactive hidden" id="mobile-more-sheet">
          <div class="mob-sheet-header">
            <span>대국 보조 · 시점 · 반상 설정</span>
            <button class="btn btn-sm" id="mob-btn-close-more">닫기</button>
          </div>
          <div class="mob-sheet-grid">
            <button class="btn btn-sm" data-cam="true_top">수직뷰</button>
            <button class="btn btn-sm" data-cam="default">기본뷰</button>
            <button class="btn btn-sm" data-cam="cinema">입체뷰</button>
            <button class="btn btn-sm" id="mob-sheet-coords">좌표 눈금</button>
            <button class="btn btn-sm" id="mob-sheet-nums">수순 번호</button>
            <button class="btn btn-sm" id="mob-sheet-hint">형세 보기</button>
            <button class="btn btn-sm" id="mob-sheet-stir">잘그락</button>
            <button class="btn btn-sm" id="mob-sheet-nick">닉네임</button>
            <button class="btn btn-sm" id="mob-sheet-save-sgf">SGF 저장</button>
            <button class="btn btn-sm" id="mob-sheet-open-sgf">기보 열기</button>
            <button class="btn btn-sm btn-gold hidden" id="mob-sheet-result">계가 결과</button>
            <button class="btn btn-sm btn-danger" id="mob-sheet-resign">기권하기</button>
          </div>
        </div>
      </div>

      <!-- Byoyomi <= 10s Non-Blocking Edge Pulse & Center-Bottom Countdown Banner -->
      <div class="byoyomi-edge-pulse hidden" id="byoyomi-edge-pulse" aria-hidden="true"></div>
      <div class="byoyomi-countdown-banner hidden" id="byoyomi-countdown-banner" aria-live="polite">
        <div class="byoyomi-count-num" id="byoyomi-count-num">10</div>
        <div class="byoyomi-count-copy">
          <div class="byoyomi-count-title" id="byoyomi-count-title">초읽기 카운트다운</div>
          <div class="byoyomi-count-sub" id="byoyomi-count-sub">남은 초읽기 3회</div>
        </div>
      </div>

      <!-- Interactive Tutorial Coach Panel (Non-Blocking) -->
      <div class="tutorial-coach-panel interactive hidden" id="tutorial-coach-panel">
        <div class="tut-coach-header">
          <div>
            <div class="tut-coach-badge">초보자 입문 튜토리얼</div>
            <h4 class="tut-coach-title" id="tut-coach-title">단수와 따내기</h4>
          </div>
          <span class="tut-coach-step" id="tut-coach-step">1 / 3단계</span>
        </div>
        <p class="tut-coach-text" id="tut-coach-text"></p>
        <div class="tut-coach-feedback hidden" id="tut-coach-feedback"></div>
        <div class="tut-coach-hint hidden" id="tut-coach-hint"></div>
        <div class="tut-coach-actions">
          <button class="btn btn-sm" id="btn-tut-hint">힌트 보기</button>
          <button class="btn btn-sm" id="btn-tut-retry">단계 초기화</button>
          <button class="btn btn-sm btn-gold hidden" id="btn-tut-next">다음 단계 ▶</button>
          <button class="btn btn-sm btn-danger" id="btn-tut-exit">학습 종료</button>
        </div>
      </div>

      <!-- Toast Notifications -->
      <div class="toast-container" id="toast-container"></div>

      <!-- New Game & Online Multiplayer Setup Modal -->
      <div class="modal-backdrop" id="modal-setup">
        <div class="modal-card modal-wide">
          <div class="modal-header">
            <h2>대국 설정 — 수담(手談)</h2>
            <div class="modal-header-actions">
              <button class="btn btn-sm btn-tutorial-nav" id="btn-setup-open-tutorial">📖 초보자 입문·학습</button>
              <button class="btn btn-sm" id="btn-close-setup">닫기</button>
            </div>
          </div>

          <!-- Persistent Player Nickname Bar -->
          <div class="nickname-bar">
            <span class="nickname-bar-label">내 닉네임</span>
            <input
              type="text"
              class="text-input"
              id="inp-setup-nick"
              maxlength="14"
              value="${escapeHtml(this.currentNickname)}"
              placeholder="닉네임 입력 (최대 14자)"
            />
            <button class="btn btn-sm" id="btn-setup-nick-random" title="멋진 바둑 닉네임 자동 추천">랜덤</button>
            <button class="btn btn-sm btn-gold" id="btn-setup-nick-save">저장</button>
          </div>

          <div class="form-section">
            <span class="form-label">대국 모드 선택</span>
            <div class="seg-group" id="seg-mode">
              <button class="seg-btn selected" data-val="ai">1인 대국 (인공지능)</button>
              <button class="seg-btn" data-val="local2p">2인 대국 (맞대국)</button>
              <button class="seg-btn" data-val="online">온라인 멀티 (실시간)</button>
            </div>
          </div>

          <!-- OFFLINE (1P AI / 2P Local) OPTIONS -->
          <div id="offline-options-wrap">
            <div class="form-section">
              <span class="form-label">종목 선택</span>
              <div class="seg-group" id="seg-game-type">
                <button class="seg-btn selected" data-val="baduk">정통 바둑 (Baduk)</button>
                <button class="seg-btn" data-val="omok">오목 (Omok · 5목)</button>
              </div>
            </div>

            <div id="ai-options-panel">
              <div class="form-section">
                <span class="form-label">인공지능 난이도 (5단계)</span>
                <div class="seg-group" id="seg-difficulty">
                  <button class="seg-btn" data-val="1">입문</button>
                  <button class="seg-btn" data-val="2">초급</button>
                  <button class="seg-btn selected" data-val="3">중급</button>
                  <button class="seg-btn" data-val="4">고급</button>
                  <button class="seg-btn" data-val="5">마스터</button>
                </div>
                <div class="ai-desc-hint" id="ai-desc-hint">${AI_LEVEL_DESCRIPTIONS[3]}</div>
              </div>

              <div class="form-section">
                <span class="form-label">내 돌 선택</span>
                <div class="seg-group" id="seg-color">
                  <button class="seg-btn selected" data-val="black">흑 (선번)</button>
                  <button class="seg-btn" data-val="white">백 (덤 수령)</button>
                  <button class="seg-btn" data-val="random">돌가리기 (랜덤)</button>
                </div>
              </div>
            </div>

            <div class="form-section">
              <span class="form-label" id="lbl-offline-size">판 크기</span>
              <div class="seg-group" id="seg-size">
                <button class="seg-btn selected" data-val="19">19줄 (정식 대국)</button>
                <button class="seg-btn hidden" data-val="15">15줄 (오목 표준)</button>
                <button class="seg-btn" data-val="13">13줄 (중형 전략)</button>
                <button class="seg-btn" data-val="9">9줄 (입문·속기)</button>
              </div>
            </div>

            <div class="form-section" id="offline-baduk-rules-sec">
              <span class="form-label">바둑 규칙 및 계가 방식</span>
              <div class="seg-group" id="seg-ruleset">
                <button class="seg-btn selected" data-val="korean">한국식 규칙 (집 + 사석)</button>
                <button class="seg-btn" data-val="chinese">중국식 규칙 (생존돌 + 집 면적)</button>
              </div>
            </div>

            <div class="form-section hidden" id="offline-omok-rules-sec">
              <span class="form-label">오목 규칙</span>
              <div class="seg-group" id="seg-omok-ruleset">
                <button class="seg-btn selected" data-val="renju">렌주룰 (흑 3·3 / 4·4 / 장목 금수)</button>
                <button class="seg-btn" data-val="freestyle">자유룰 (흑·백 금수 없음)</button>
              </div>
            </div>

            <div class="form-row-2 form-section" id="offline-baduk-handicap-sec">
              <div>
                <label class="form-label" for="sel-handicap">접바둑 (치석)</label>
                <select class="select-input" id="sel-handicap">
                  <option value="0" selected>호선 (맞바둑)</option>
                  <option value="2">2점 접바둑 (백 선수)</option>
                  <option value="3">3점 접바둑</option>
                  <option value="4">4점 접바둑</option>
                  <option value="5">5점 접바둑</option>
                  <option value="6">6점 접바둑</option>
                  <option value="7">7점 접바둑</option>
                  <option value="8">8점 접바둑</option>
                  <option value="9">9점 접바둑</option>
                </select>
              </div>
              <div>
                <label class="form-label" for="inp-komi">덤 (Komi, 집)</label>
                <input type="number" step="0.5" class="num-input" id="inp-komi" value="6.5" />
              </div>
            </div>

            <div class="form-section">
              <label class="form-label" for="sel-time">제한시간 및 초읽기</label>
              <select class="select-input" id="sel-time">
                <option value="10m_30s" selected>표준 대국 (제한시간 10분 + 초읽기 30초 3회)</option>
                <option value="5m_30s">속기 대국 (제한시간 5분 + 초읽기 30초 3회)</option>
                <option value="20m_40s">장고 대국 (제한시간 20분 + 초읽기 40초 3회)</option>
                <option value="0m_30s">초읽기 전용 (30초 3회)</option>
                <option value="unlimited">시간 무제한 (여유로운 수담)</option>
              </select>
            </div>

            <div class="modal-footer">
              <button class="btn btn-gold" id="btn-start-game">대국 시작하기</button>
            </div>
          </div>

          <!-- ONLINE MULTIPLAYER LOBBY PANEL -->
          <div id="online-lobby-wrap" class="hidden">
            <div class="online-status-strip">
              <div class="online-status-left">
                <span class="status-indicator" id="online-status-dot"></span>
                <span id="online-status-text">온라인 매칭 중계망 준비 중...</span>
              </div>
              <span>실시간 2인 동기화</span>
            </div>

            <div class="seg-group" id="seg-online-sub">
              <button class="seg-btn selected" data-val="quick">빠른 매칭</button>
              <button class="seg-btn" data-val="create">방 만들기</button>
              <button class="seg-btn" data-val="join">방 참가 · 대기실 목록</button>
            </div>

            <!-- Sub-tab 1: Quick Match -->
            <div class="online-sub-box" id="online-sub-quick">
              <div id="qm-idle-box">
                <div class="qm-hero">
                  <h4>실시간 자동 빠른 매칭</h4>
                  <p>접속 중인 다른 대국자와 즉시 연결되어 흑·백 돌가리기 후 실시간 2인 대국을 시작합니다.</p>
                </div>
                <div class="form-row-2 form-section">
                  <div>
                    <span class="form-label">매칭 종목</span>
                    <div class="seg-group" id="seg-qm-gametype">
                      <button class="seg-btn selected" data-val="baduk">정통 바둑</button>
                      <button class="seg-btn" data-val="omok">오목</button>
                    </div>
                  </div>
                  <div class="hidden" id="qm-omok-ruleset-sec">
                    <span class="form-label">오목 규칙</span>
                    <div class="seg-group" id="seg-qm-omok-rule">
                      <button class="seg-btn selected" data-val="renju">렌주룰</button>
                      <button class="seg-btn" data-val="freestyle">자유룰</button>
                    </div>
                  </div>
                </div>
                <div class="form-section">
                  <span class="form-label">선호 판 크기</span>
                  <div class="seg-group" id="seg-qm-size">
                    <button class="seg-btn selected" data-val="any">전체 (가장 빠름)</button>
                    <button class="seg-btn" data-val="19">19줄</button>
                    <button class="seg-btn hidden" data-val="15">15줄</button>
                    <button class="seg-btn" data-val="13">13줄</button>
                    <button class="seg-btn" data-val="9">9줄</button>
                  </div>
                </div>
                <div style="display: flex; justify-content: center; margin-top: 14px;">
                  <button class="btn btn-gold" id="btn-qm-start" style="padding: 10px 28px; font-size: 14.5px;">
                    빠른 매칭 시작하기
                  </button>
                </div>
              </div>

              <div id="qm-searching-box" class="qm-searching-box hidden">
                <div class="stone-radar">
                  <div class="stone-radar-core"></div>
                </div>
                <div class="qm-timer-text" id="qm-timer-text">상대 대국자를 탐색하는 중... (00:00)</div>
                <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
                  조건이 맞는 상대가 접속하면 자동으로 대국실이 열립니다.
                </p>
                <button class="btn btn-danger" id="btn-qm-cancel">매칭 탐색 취소</button>
              </div>
            </div>

            <!-- Sub-tab 2: Create Room -->
            <div class="online-sub-box hidden" id="online-sub-create">
              <div id="create-form-box">
                <div class="form-row-2 form-section">
                  <div>
                    <label class="form-label" for="inp-room-title">대국방 이름</label>
                    <input
                      type="text"
                      class="text-input"
                      id="inp-room-title"
                      maxlength="28"
                      placeholder="예: 즐거운 수담 한 판 두실 분!"
                    />
                  </div>
                  <div>
                    <span class="form-label">공개 설정</span>
                    <div class="seg-group" id="seg-room-vis">
                      <button class="seg-btn selected" data-val="public">공개방</button>
                      <button class="seg-btn" data-val="private">비공개 비밀번호방</button>
                    </div>
                  </div>
                </div>

                <div class="form-section hidden" id="room-password-wrap">
                  <label class="form-label" for="inp-room-password">비공개방 비밀번호 (방 목록에는 표시되지만 비밀번호 입력 시에만 입장/관전 가능)</label>
                  <input
                    type="password"
                    class="text-input"
                    id="inp-room-password"
                    maxlength="24"
                    placeholder="대국 입장 및 관전용 비밀번호를 입력하세요"
                  />
                </div>

                <div class="form-section">
                  <span class="form-label">종목 선택</span>
                  <div class="seg-group" id="seg-room-gametype">
                    <button class="seg-btn selected" data-val="baduk">정통 바둑</button>
                    <button class="seg-btn" data-val="omok">오목 (Omok)</button>
                  </div>
                </div>

                <div class="form-row-2 form-section">
                  <div>
                    <span class="form-label">판 크기</span>
                    <div class="seg-group" id="seg-room-size">
                      <button class="seg-btn selected" data-val="19">19줄</button>
                      <button class="seg-btn hidden" data-val="15">15줄</button>
                      <button class="seg-btn" data-val="13">13줄</button>
                      <button class="seg-btn" data-val="9">9줄</button>
                    </div>
                  </div>
                  <div id="room-baduk-rules-sec">
                    <span class="form-label">계가 규칙</span>
                    <div class="seg-group" id="seg-room-rule">
                      <button class="seg-btn selected" data-val="korean">한국식</button>
                      <button class="seg-btn" data-val="chinese">중국식</button>
                    </div>
                  </div>
                  <div class="hidden" id="room-omok-rules-sec">
                    <span class="form-label">오목 규칙</span>
                    <div class="seg-group" id="seg-room-omok-rule">
                      <button class="seg-btn selected" data-val="renju">렌주룰</button>
                      <button class="seg-btn" data-val="freestyle">자유룰</button>
                    </div>
                  </div>
                </div>

                <div class="form-row-2 form-section" id="room-baduk-handicap-sec">
                  <div>
                    <label class="form-label" for="sel-room-handicap">접바둑 (치석)</label>
                    <select class="select-input" id="sel-room-handicap">
                      <option value="0" selected>호선 (맞바둑)</option>
                      <option value="2">2점 접바둑</option>
                      <option value="3">3점 접바둑</option>
                      <option value="4">4점 접바둑</option>
                      <option value="5">5점 접바둑</option>
                      <option value="6">6점 접바둑</option>
                      <option value="7">7점 접바둑</option>
                      <option value="8">8점 접바둑</option>
                      <option value="9">9점 접바둑</option>
                    </select>
                  </div>
                  <div>
                    <label class="form-label" for="inp-room-komi">덤 (집)</label>
                    <input type="number" step="0.5" class="num-input" id="inp-room-komi" value="6.5" />
                  </div>
                </div>

                <div class="form-row-2 form-section">
                  <div>
                    <label class="form-label" for="sel-room-time">제한시간</label>
                    <select class="select-input" id="sel-room-time">
                      <option value="10m_30s" selected>10분 + 초읽기 30초 3회</option>
                      <option value="5m_30s">5분 + 초읽기 30초 3회</option>
                      <option value="20m_40s">20분 + 초읽기 40초 3회</option>
                      <option value="0m_30s">초읽기 30초 3회</option>
                      <option value="unlimited">시간 무제한</option>
                    </select>
                  </div>
                  <div>
                    <span class="form-label">방장 돌 선택</span>
                    <div class="seg-group" id="seg-room-color">
                      <button class="seg-btn" data-val="black">흑</button>
                      <button class="seg-btn" data-val="white">백</button>
                      <button class="seg-btn selected" data-val="random">돌가리기</button>
                    </div>
                  </div>
                </div>

                <div style="display: flex; justify-content: flex-end; margin-top: 12px;">
                  <button class="btn btn-gold" id="btn-create-room">온라인 대국방 만들기</button>
                </div>
              </div>

              <!-- Host Waiting Room View -->
              <div id="waiting-room-box" class="waiting-room-box hidden">
                <div class="waiting-room-label">대국방 입장 코드 (상대방에게 공유하세요)</div>
                <div class="room-code-big selectable-text" id="waiting-room-code">------</div>
                <div class="waiting-room-actions">
                  <button class="btn btn-sm btn-gold" id="btn-copy-code">방 코드 복사</button>
                  <button class="btn btn-sm" id="btn-copy-invite">초대 링크 복사</button>
                </div>
                <div class="waiting-room-meta" id="waiting-room-meta"></div>
                <div class="waiting-pulse-msg">상대 대국자 입장 대기 중... 입장 시 즉시 대국이 시작됩니다.</div>
                <button class="btn btn-danger" id="btn-cancel-room">대기방 닫기</button>
              </div>
            </div>

            <!-- Sub-tab 3: Join Room / Open Room Browser -->
            <div class="online-sub-box hidden" id="online-sub-join">
              <span class="form-label">6자리 방 코드로 바로 입장</span>
              <div class="join-code-row">
                <input
                  type="text"
                  class="text-input"
                  id="inp-join-code"
                  maxlength="8"
                  placeholder="방 코드 입력 (예: K7M9P2)"
                />
                <button class="btn btn-gold" id="btn-join-code">코드로 입장</button>
              </div>
              <div class="waiting-pulse-msg hidden" id="joining-status-msg">
                대국방에 연결하고 있습니다... 잠시만 기다려 주세요.
              </div>

              <div class="open-rooms-header">
                <span class="form-label" style="margin-bottom: 0;">실시간 대국방 목록 (공개 · 비공개 · 실시간 관전)</span>
                <button class="btn btn-sm" id="btn-refresh-rooms">목록 새로고침</button>
              </div>
              <div class="seg-group room-filter-bar" id="seg-room-filter">
                <button class="seg-btn selected" data-val="all">전체 보기</button>
                <button class="seg-btn" data-val="waiting">대기 중</button>
                <button class="seg-btn" data-val="in_game">대국 중 (관전 가능)</button>
              </div>
              <div class="open-rooms-list" id="open-rooms-list">
                <div class="empty-rooms-msg">
                  현재 열린 대국방이 없습니다. 직접 방을 만들거나 빠른 매칭을 시작해 보세요!
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Private Room Password Prompt Modal -->
      <div class="modal-backdrop hidden" id="modal-room-password">
        <div class="modal-card modal-compact">
          <div class="modal-header">
            <h2 id="pw-modal-title">비공개 대국실 입장</h2>
            <button class="btn btn-sm" id="btn-close-room-pw">닫기</button>
          </div>
          <p class="pw-modal-desc" id="pw-modal-desc">이 대국실은 비밀번호로 보호되어 있습니다.</p>
          <div class="form-section">
            <label class="form-label" for="inp-modal-room-password">비밀번호 입력</label>
            <input
              type="password"
              class="text-input"
              id="inp-modal-room-password"
              maxlength="24"
              placeholder="비밀번호를 입력하세요"
            />
            <div class="pw-modal-error hidden" id="pw-modal-error"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" id="btn-cancel-room-pw">취소</button>
            <button class="btn btn-gold" id="btn-submit-room-pw">확인</button>
          </div>
        </div>
      </div>

      <!-- Inline Nickname Edit Modal -->
      <div class="modal-backdrop hidden" id="modal-nickname">
        <div class="modal-card modal-compact">
          <div class="modal-header">
            <h2>내 닉네임 설정</h2>
            <button class="btn btn-sm" id="btn-close-nick">닫기</button>
          </div>
          <div class="form-section">
            <label class="form-label" for="inp-modal-nick">표시할 대국자 닉네임 (1~14자)</label>
            <div style="display: flex; gap: 8px;">
              <input
                type="text"
                class="text-input"
                id="inp-modal-nick"
                maxlength="14"
                value="${escapeHtml(this.currentNickname)}"
              />
              <button class="btn" id="btn-modal-nick-random">랜덤 추천</button>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" id="btn-cancel-nick">취소</button>
            <button class="btn btn-gold" id="btn-save-nick">닉네임 저장</button>
          </div>
        </div>
      </div>

      <!-- Game Result Modal -->
      <div class="modal-backdrop hidden" id="modal-result">
        <div class="modal-card">
          <div class="modal-header">
            <h2>대국 결과서</h2>
            <button class="btn btn-sm" id="btn-close-result">닫기</button>
          </div>
          <div id="result-modal-body"></div>
          <div class="modal-footer">
            <button class="btn" id="btn-res-review">기보 복기하기</button>
            <button class="btn" id="btn-res-sgf">SGF 기보 저장</button>
            <button class="btn btn-gold hidden" id="btn-res-rematch">온라인 재대국 신청</button>
            <button class="btn btn-gold" id="btn-res-new">새 대국 시작</button>
          </div>
        </div>
      </div>

      <!-- Options & Preferences Modal -->
      <div class="modal-backdrop hidden" id="modal-options">
        <div class="modal-card modal-options-card">
          <div class="modal-header">
            <h2>대국 환경 · 모션 · 시점 옵션</h2>
            <button class="btn btn-sm" id="btn-close-options">닫기</button>
          </div>

          <div class="options-section">
            <div class="options-section-title">그래픽 마감 및 퀄리티 (Visual Quality &amp; Finish)</div>
            <div class="seg-group" id="seg-opt-quality">
              <button class="seg-btn" data-val="ultra">극상 장인 마감 (Ultra)</button>
              <button class="seg-btn" data-val="high">고급 마감 (High)</button>
              <button class="seg-btn" data-val="standard">표준 성능 (Standard)</button>
            </div>
            <div class="toggle-list" style="margin-top: 8px;">
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">HDR 블룸 및 부드러운 안티에일리어싱 (Bloom · SMAA)</span>
                  <span class="toggle-row-desc">따뜻한 호롱불 잔광과 바둑돌·황동 장식의 고급 광택 및 계단 현상 억제를 적용합니다.</span>
                </div>
                <input type="checkbox" id="opt-bloom" />
              </label>
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">화려한 전통 나전칠기 · 비단 방석 · 한옥 등불 마감</span>
                  <span class="toggle-row-desc">반상 옆 다탁의 자개 문양, 청홍 비단 방석, 황동 장식과 공기 중 부유 먼지를 표현합니다.</span>
                </div>
                <input type="checkbox" id="opt-ornate-finish" />
              </label>
            </div>
          </div>

          <div class="options-section">
            <div class="options-section-title">착수 모션 (Placement Motion)</div>
            <div class="seg-group" id="seg-opt-motion">
              <button class="seg-btn" data-val="realistic">실사 손가락 착수 (기본)</button>
              <button class="seg-btn" data-val="classic_bowl">기존 바둑통 포물선</button>
              <button class="seg-btn" data-val="instant">즉시 착수</button>
            </div>
            <div class="option-hint" style="margin-top: 6px;">
              실사 손가락 착수는 바둑알이 판 위 근거리에서 테두리로 닿았다가 딱! 눕는 탄성 감쇠 모션을 적용합니다.
            </div>
          </div>

          <div class="options-section">
            <div class="options-section-title">진짜 90° 수직뷰 &amp; 모바일 시점</div>
            <div class="toggle-list">
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">원근 왜곡 없는 90° 정밀 수직뷰 기본 적용</span>
                  <span class="toggle-row-desc">대국 시작 시 평면 직교(Orthographic) 90° 수직 시점을 기본으로 사용합니다.</span>
                </div>
                <input type="checkbox" id="opt-true-vertical" />
              </label>
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">모바일 세로 화면 자동 맞춤 수직뷰</span>
                  <span class="toggle-row-desc">스마트폰 세로 화면에서 여백 없이 반상이 꽉 차는 수직뷰를 자동 적용합니다.</span>
                </div>
                <input type="checkbox" id="opt-auto-mobile-vertical" />
              </label>
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">수직뷰 회전 잠금 (실수 시점 틀어짐 방지)</span>
                  <span class="toggle-row-desc">수직뷰 상태에서 손가락 드래그로 카메라가 회전하지 않도록 고정합니다.</span>
                </div>
                <input type="checkbox" id="opt-lock-vertical-rot" />
              </label>
            </div>
          </div>

          <div class="options-section">
            <div class="options-section-title">모바일 &amp; 착수 실수 방지</div>
            <div class="seg-group" id="seg-opt-input">
              <button class="seg-btn" data-val="auto">자동 (PC 즉시/모바일 확인)</button>
              <button class="seg-btn" data-val="confirm">2단계 확인 착수</button>
              <button class="seg-btn" data-val="double_tap">두 번 탭</button>
              <button class="seg-btn" data-val="instant">원터치 즉시</button>
            </div>
            <div class="toggle-list" style="margin-top: 8px;">
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">터치 드래그 2.6× 정밀 확대경 사용</span>
                  <span class="toggle-row-desc">모바일 터치 시 손가락 위 오프셋 원형 루페로 정확한 교차점을 미리 확인합니다.</span>
                </div>
                <input type="checkbox" id="opt-touch-loupe" />
              </label>
            </div>
          </div>

          <div class="options-section">
            <div class="options-section-title">UI 레이아웃 &amp; 반상 격자선 가시성 (모바일 선명도)</div>
            <div class="form-section" style="margin-bottom: 10px;">
              <span class="form-label">화면 인터페이스 (UI) 모드</span>
              <div class="seg-group" id="seg-opt-ui-layout">
                <button class="seg-btn" data-val="auto">자동 (PC / 모바일 맞춤)</button>
                <button class="seg-btn" data-val="mobile">모바일 전용 컴팩트 UI</button>
                <button class="seg-btn" data-val="desktop">PC 와이드 UI</button>
              </div>
            </div>
            <div class="form-section" style="margin-bottom: 10px;">
              <span class="form-label">반상 나무결 농도 (배경 무늬 진하기)</span>
              <div class="seg-group" id="seg-opt-grain">
                <button class="seg-btn" data-val="classic">전통 나뭇결</button>
                <button class="seg-btn" data-val="soft">부드러운 은은결</button>
                <button class="seg-btn" data-val="plain">단색 무지 (최고 시인성)</button>
              </div>
            </div>
            <div class="form-section" style="margin-bottom: 10px;">
              <span class="form-label">바둑판 가로·세로 선 대비 (선명도)</span>
              <div class="seg-group" id="seg-opt-line-contrast">
                <button class="seg-btn" data-val="normal">기본 먹선</button>
                <button class="seg-btn" data-val="bold">진한 먹선</button>
                <button class="seg-btn" data-val="high">고대비 선명+밝은 외곽선</button>
              </div>
            </div>
            <button class="btn btn-sm btn-gold" id="btn-opt-mobile-visibility" style="width: 100%;">
              📱 모바일 추천: 은은결 + 고대비 격자선 즉시 적용
            </button>
          </div>

          <div class="options-section">
            <div class="options-section-title">물리 엔진 · 반상 조명 테마 및 밝기</div>
            <div class="form-section" style="margin-bottom: 10px;">
              <span class="form-label">강체 물리 충돌 시뮬레이션</span>
              <div class="seg-group" id="seg-opt-physics">
                <button class="seg-btn" data-val="realistic">실감 물리 (미세 밀림·탄성·접지)</button>
                <button class="seg-btn" data-val="subtle">표준 물리</button>
                <button class="seg-btn" data-val="minimal">경량 (저전력)</button>
              </div>
            </div>
            <div class="form-section" style="margin-bottom: 10px;">
              <span class="form-label">조명 분위기</span>
              <div class="seg-group" id="seg-opt-lighting">
                <button class="seg-btn" data-val="hanok_warm">전통 한옥</button>
                <button class="seg-btn" data-val="studio_bright">밝은 대국실</button>
                <button class="seg-btn" data-val="night_lantern">야간 호롱불</button>
              </div>
            </div>
            <div>
              <div class="slider-label-row">
                <span class="form-label">반상 조명 밝기 (눈부심 조절)</span>
                <strong class="slider-val-badge" id="lbl-opt-brightness">100%</strong>
              </div>
              <input
                type="range"
                class="opt-range-slider"
                id="slider-opt-brightness"
                min="50"
                max="150"
                step="5"
                value="100"
              />
            </div>
          </div>

          <div class="options-section">
            <div class="options-section-title">기타 보조 및 음향</div>
            <div class="toggle-list">
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">오목 렌주룰 흑 금수 자리(✕) 표시</span>
                  <span class="toggle-row-desc">흑 차례일 때 3·3 / 4·4 / 장목 금수 교차점을 보드에 표기합니다.</span>
                </div>
                <input type="checkbox" id="opt-show-forbidden" />
              </label>
              <label class="toggle-row">
                <div class="toggle-row-text">
                  <span class="toggle-row-title">반상 좌표 눈금 표시</span>
                  <span class="toggle-row-desc">비자나무 반상 가장자리의 영문/숫자 좌표를 표시합니다.</span>
                </div>
                <input type="checkbox" id="opt-show-coords" />
              </label>
            </div>
          </div>

          <div class="options-footer">
            <button class="btn" id="btn-options-reset">기본값 복원</button>
            <button class="btn btn-gold" id="btn-options-close-footer">설정 저장 후 닫기</button>
          </div>
        </div>
      </div>

      <!-- Beginner Tutorial & Learning Curriculum Modal -->
      <div class="modal-backdrop hidden" id="modal-tutorial">
        <div class="modal-card modal-wide modal-tutorial-card">
          <div class="modal-header">
            <div>
              <h2>초보자 입문 튜토리얼 &amp; 실전 학습</h2>
              <div class="modal-subline" id="tutorial-progress-summary">완료한 학습: 0 / 9</div>
            </div>
            <button class="btn btn-sm" id="btn-close-tutorial">닫기</button>
          </div>
          <div class="tutorial-lesson-grid" id="tutorial-lesson-grid"></div>
        </div>
      </div>

      <!-- Account / IP Ban Blocker Modal -->
      <div class="modal-backdrop hidden" id="modal-ban-notice">
        <div class="modal-card modal-ban-card">
          <div class="modal-header">
            <h2>온라인 서비스 이용 제한 안내</h2>
          </div>
          <div id="ban-notice-body" class="ban-notice-body"></div>
          <div class="modal-footer">
            <button class="btn btn-gold" id="btn-close-ban-modal">확인</button>
          </div>
        </div>
      </div>
    `;

    this.cacheRefsAndBind();
  }

  private cacheRefsAndBind(): void {
    this.brandTitleEl = this.root.querySelector('#ui-brand-title')!;
    this.metaBadgeEl = this.root.querySelector('#ui-meta-badge')!;
    this.coordBadgeEl = this.root.querySelector('#ui-coord-badge')!;
    this.onlineHudPillEl = this.root.querySelector('#ui-online-pill')!;
    this.onlineHudTextEl = this.root.querySelector('#ui-online-pill-text')!;
    this.leaveOnlineBtn = this.root.querySelector('#btn-leave-online') as HTMLButtonElement;
    this.topNickLabelEl = this.root.querySelector('#top-nick-label')!;

    this.blackCardEl = this.root.querySelector('#card-black')!;
    this.whiteCardEl = this.root.querySelector('#card-white')!;
    this.blackNameEl = this.root.querySelector('#name-black')!;
    this.whiteNameEl = this.root.querySelector('#name-white')!;
    this.blackSubEl = this.root.querySelector('#sub-black')!;
    this.whiteSubEl = this.root.querySelector('#sub-white')!;
    this.blackTurnPill = this.root.querySelector('#pill-black')!;
    this.whiteTurnPill = this.root.querySelector('#pill-white')!;
    this.blackCapturesEl = this.root.querySelector('#cap-black')!;
    this.whiteCapturesEl = this.root.querySelector('#cap-white')!;
    this.blackClockEl = this.root.querySelector('#clock-black')!;
    this.whiteClockEl = this.root.querySelector('#clock-white')!;
    this.blackBubbleEl = this.root.querySelector('#bubble-black')!;
    this.whiteBubbleEl = this.root.querySelector('#bubble-white')!;

    this.scoringBannerEl = this.root.querySelector('#scoring-banner')!;
    this.scoringTallyEl = this.root.querySelector('#scoring-live-tally')!;
    this.confirmScoreBtn = this.root.querySelector('#btn-confirm-score') as HTMLButtonElement;
    this.resumeScoreBtn = this.root.querySelector('#btn-resume-play') as HTMLButtonElement;
    this.scoringDescEl = this.root.querySelector('#scoring-desc-text')!;

    this.onlinePromptBannerEl = this.root.querySelector('#online-prompt-banner')!;
    this.onlinePromptTextEl = this.root.querySelector('#online-prompt-text')!;

    this.reviewBarEl = this.root.querySelector('#review-bar')!;
    this.reviewSliderEl = this.root.querySelector('#rev-slider') as HTMLInputElement;
    this.reviewLabelEl = this.root.querySelector('#rev-label')!;
    this.reviewChartCanvasEl = this.root.querySelector('#rev-winrate-chart') as HTMLCanvasElement;
    this.reviewWinrateLabelEl = this.root.querySelector('#rev-winrate-label')!;

    this.pendingMoveBarEl = this.root.querySelector('#pending-move-bar')!;
    this.pendingCoordEl = this.root.querySelector('#pending-move-coord')!;

    this.chatPopoverEl = this.root.querySelector('#chat-popover')!;
    this.chatToggleBtn = this.root.querySelector('#btn-chat-toggle') as HTMLButtonElement;
    this.chatInputEl = this.root.querySelector('#inp-online-chat') as HTMLInputElement;
    this.chatRoleBannerEl = this.root.querySelector('#chat-role-banner')!;
    this.chatMessagesListEl = this.root.querySelector('#chat-messages-list')!;
    this.chatUnreadBadgeEl = this.root.querySelector('#chat-unread-badge')!;
    this.quickEmotesGridEl = this.root.querySelector('#quick-emotes-grid')!;

    this.passBtn = this.root.querySelector('#btn-pass') as HTMLButtonElement;
    this.undoBtn = this.root.querySelector('#btn-undo') as HTMLButtonElement;
    this.resignBtn = this.root.querySelector('#btn-resign') as HTMLButtonElement;
    this.aiHintBtn = this.root.querySelector('#btn-ai-hint') as HTMLButtonElement;
    this.hintBtn = this.root.querySelector('#btn-territory-hint') as HTMLButtonElement;
    this.moveNumBtn = this.root.querySelector('#btn-move-nums') as HTMLButtonElement;
    this.coordsBtn = this.root.querySelector('#btn-coords') as HTMLButtonElement;
    this.showResultBtn = this.root.querySelector('#btn-show-result') as HTMLButtonElement;

    this.setupModalEl = this.root.querySelector('#modal-setup')!;
    this.setupNickInputEl = this.root.querySelector('#inp-setup-nick') as HTMLInputElement;
    this.nickModalEl = this.root.querySelector('#modal-nickname')!;
    this.nickModalInputEl = this.root.querySelector('#inp-modal-nick') as HTMLInputElement;
    this.passwordModalEl = this.root.querySelector('#modal-room-password')!;
    this.passwordModalTitleEl = this.root.querySelector('#pw-modal-title')!;
    this.passwordModalDescEl = this.root.querySelector('#pw-modal-desc')!;
    this.passwordModalErrorEl = this.root.querySelector('#pw-modal-error')!;
    this.passwordModalInputEl = this.root.querySelector('#inp-modal-room-password') as HTMLInputElement;

    this.webPresenceBadgeEl = this.root.querySelector('#web-live-users-badge')!;
    this.webPresenceCountEl = this.root.querySelector('#web-presence-count')!;
    this.webPresenceDetailEl = this.root.querySelector('#web-presence-detail')!;

    this.onlineStatusDotEl = this.root.querySelector('#online-status-dot')!;
    this.onlineStatusTextEl = this.root.querySelector('#online-status-text')!;
    this.qmIdleBoxEl = this.root.querySelector('#qm-idle-box')!;
    this.qmSearchingBoxEl = this.root.querySelector('#qm-searching-box')!;
    this.qmTimerTextEl = this.root.querySelector('#qm-timer-text')!;
    this.createFormBoxEl = this.root.querySelector('#create-form-box')!;
    this.roomPasswordWrapEl = this.root.querySelector('#room-password-wrap')!;
    this.roomPasswordInputEl = this.root.querySelector('#inp-room-password') as HTMLInputElement;
    this.waitingRoomBoxEl = this.root.querySelector('#waiting-room-box')!;
    this.waitingRoomCodeEl = this.root.querySelector('#waiting-room-code')!;
    this.waitingRoomMetaEl = this.root.querySelector('#waiting-room-meta')!;
    this.openRoomsListEl = this.root.querySelector('#open-rooms-list')!;
    this.joinCodeInputEl = this.root.querySelector('#inp-join-code') as HTMLInputElement;
    this.joiningStatusMsgEl = this.root.querySelector('#joining-status-msg')!;

    this.resultModalEl = this.root.querySelector('#modal-result')!;
    this.resultBodyEl = this.root.querySelector('#result-modal-body')!;
    this.rematchResultBtn = this.root.querySelector('#btn-res-rematch') as HTMLButtonElement;
    this.optionsModalEl = this.root.querySelector('#modal-options')!;
    this.toastContainerEl = this.root.querySelector('#toast-container')!;

    // Byoyomi 10s urgent visual alert refs
    this.byoyomiPulseEl = this.root.querySelector('#byoyomi-edge-pulse')!;
    this.byoyomiBannerEl = this.root.querySelector('#byoyomi-countdown-banner')!;
    this.byoyomiBannerNumEl = this.root.querySelector('#byoyomi-count-num')!;
    this.byoyomiBannerLabelEl = this.root.querySelector('#byoyomi-count-title')!;
    this.byoyomiBannerSubEl = this.root.querySelector('#byoyomi-count-sub')!;

    // Tutorial Coach & Selector Modal refs
    this.tutorialCoachEl = this.root.querySelector('#tutorial-coach-panel')!;
    this.tutorialCoachTitleEl = this.root.querySelector('#tut-coach-title')!;
    this.tutorialCoachStepEl = this.root.querySelector('#tut-coach-step')!;
    this.tutorialCoachTextEl = this.root.querySelector('#tut-coach-text')!;
    this.tutorialCoachFeedbackEl = this.root.querySelector('#tut-coach-feedback')!;
    this.tutorialCoachHintEl = this.root.querySelector('#tut-coach-hint')!;
    this.tutorialNextBtn = this.root.querySelector('#btn-tut-next') as HTMLButtonElement;
    this.tutorialModalEl = this.root.querySelector('#modal-tutorial')!;
    this.tutorialLessonGridEl = this.root.querySelector('#tutorial-lesson-grid')!;
    this.tutorialProgressSummaryEl = this.root.querySelector('#tutorial-progress-summary')!;

    // Ban Modal refs
    this.banModalEl = this.root.querySelector('#modal-ban-notice')!;
    this.banModalBodyEl = this.root.querySelector('#ban-notice-body')!;

    // Dedicated Mobile HUD refs
    this.mobTitleEl = this.root.querySelector('#mob-ui-title')!;
    this.mobOnlineBadgeEl = this.root.querySelector('#mob-online-badge')!;
    this.mobLeaveOnlineBtn = this.root.querySelector('#mob-btn-leave-online') as HTMLButtonElement;
    this.mobOppCardEl = this.root.querySelector('#mobile-opponent-bar')!;
    this.mobOppDotEl = this.root.querySelector('#mob-opp-dot')!;
    this.mobOppNameEl = this.root.querySelector('#mob-opp-name')!;
    this.mobOppCapEl = this.root.querySelector('#mob-opp-cap')!;
    this.mobOppClockEl = this.root.querySelector('#mob-opp-clock')!;
    this.mobSelfCardEl = this.root.querySelector('#mobile-self-bar')!;
    this.mobSelfDotEl = this.root.querySelector('#mob-self-dot')!;
    this.mobSelfNameEl = this.root.querySelector('#mob-self-name')!;
    this.mobSelfCapEl = this.root.querySelector('#mob-self-cap')!;
    this.mobSelfClockEl = this.root.querySelector('#mob-self-clock')!;
    this.mobCoordBadgeEl = this.root.querySelector('#mob-coord-badge')!;
    this.mobPassBtn = this.root.querySelector('#mob-btn-pass') as HTMLButtonElement;
    this.mobUndoBtn = this.root.querySelector('#mob-btn-undo') as HTMLButtonElement;
    this.mobAiHintBtn = this.root.querySelector('#mob-btn-ai-hint') as HTMLButtonElement;
    this.mobChatBtn = this.root.querySelector('#mob-btn-chat') as HTMLButtonElement;
    this.mobChatBadgeEl = this.root.querySelector('#mob-chat-unread-badge')!;
    this.mobMoreSheetEl = this.root.querySelector('#mobile-more-sheet')!;
    this.mobSheetCoordsBtn = this.root.querySelector('#mob-sheet-coords') as HTMLButtonElement;
    this.mobSheetNumsBtn = this.root.querySelector('#mob-sheet-nums') as HTMLButtonElement;
    this.mobSheetHintBtn = this.root.querySelector('#mob-sheet-hint') as HTMLButtonElement;
    this.mobSheetResignBtn = this.root.querySelector('#mob-sheet-resign') as HTMLButtonElement;
    this.mobSheetResultBtn = this.root.querySelector('#mob-sheet-result') as HTMLButtonElement;

    // Camera preset buttons
    this.camPresetBtns = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-cam]'));
    this.camPresetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.cam as CameraPreset;
        this.actions.onCameraPreset(preset);
      });
    });

    this.root.querySelector('#btn-stir-bowls')!.addEventListener('click', () => this.actions.onStirBowls());

    const muteBtn = this.root.querySelector('#btn-mute') as HTMLButtonElement;
    muteBtn.addEventListener('click', () => {
      const muted = this.actions.onToggleMute();
      muteBtn.textContent = muted ? '음소거됨' : '음향';
      muteBtn.classList.toggle('btn-danger', muted);
    });

    const volSlider = this.root.querySelector('#slider-volume') as HTMLInputElement;
    volSlider.addEventListener('input', () => {
      this.actions.onVolumeChange(Number(volSlider.value) / 100);
    });

    this.root.querySelector('#btn-open-setup')!.addEventListener('click', () => this.openSetupModal());
    this.root.querySelector('#btn-close-setup')!.addEventListener('click', () => this.closeSetupModal());
    this.root.querySelector('#btn-open-options')!.addEventListener('click', () => this.openOptionsModal());
    this.root.querySelector('#btn-fullscreen')!.addEventListener('click', () => this.actions.onToggleFullscreen());
    this.leaveOnlineBtn.addEventListener('click', () => this.actions.onLeaveOnlineMatch());

    // Beginner Tutorial controls (Top bar + Setup modal + Mobile bar + Coach panel)
    const openTutorial = () => this.actions.onOpenTutorialModal();
    this.root.querySelector('#btn-open-tutorial')!.addEventListener('click', openTutorial);
    this.root.querySelector('#btn-setup-open-tutorial')!.addEventListener('click', openTutorial);
    this.root.querySelector('#mob-btn-tutorial')!.addEventListener('click', openTutorial);
    this.root.querySelector('#btn-close-tutorial')!.addEventListener('click', () => this.closeTutorialModal());
    this.root.querySelector('#btn-tut-hint')!.addEventListener('click', () => this.actions.onToggleTutorialHint());
    this.root.querySelector('#btn-tut-retry')!.addEventListener('click', () => this.actions.onRetryTutorialStep());
    this.tutorialNextBtn.addEventListener('click', () => this.actions.onTutorialNextStep());
    this.root.querySelector('#btn-tut-exit')!.addEventListener('click', () => this.actions.onExitTutorial());

    // Ban notice modal dismiss
    this.root.querySelector('#btn-close-ban-modal')!.addEventListener('click', () => {
      this.banModalEl.classList.add('hidden');
    });

    // Dedicated Mobile HUD button bindings
    this.root.querySelector('#mob-btn-setup')!.addEventListener('click', () => this.openSetupModal());
    this.root.querySelector('#mob-btn-options')!.addEventListener('click', () => this.openOptionsModal());
    this.mobLeaveOnlineBtn.addEventListener('click', () => this.actions.onLeaveOnlineMatch());
    this.mobPassBtn.addEventListener('click', () => this.actions.onPass());
    this.mobUndoBtn.addEventListener('click', () => this.actions.onUndo());
    this.mobAiHintBtn.addEventListener('click', () => this.actions.onRequestAIHint());
    this.mobChatBtn.addEventListener('click', () => {
      const hidden = this.chatPopoverEl.classList.toggle('hidden');
      this.chatToggleBtn.classList.toggle('btn-active', !hidden);
      this.mobChatBtn.classList.toggle('btn-active', !hidden);
      if (!hidden) {
        this.mobMoreSheetEl.classList.add('hidden');
        this.chatUnreadCount = 0;
        this.syncChatUnreadBadge();
        this.chatInputEl.focus();
      }
    });
    this.root.querySelector('#mob-btn-more')!.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.toggle('hidden');
    });
    this.root.querySelector('#mob-btn-close-more')!.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
    });
    this.mobSheetCoordsBtn.addEventListener('click', () => {
      const on = this.actions.onToggleCoordinates();
      this.coordsBtn.classList.toggle('btn-active', on);
      this.mobSheetCoordsBtn.classList.toggle('btn-active', on);
    });
    this.mobSheetNumsBtn.addEventListener('click', () => {
      const on = this.actions.onToggleMoveNumbers();
      this.moveNumBtn.classList.toggle('btn-active', on);
      this.mobSheetNumsBtn.classList.toggle('btn-active', on);
    });
    this.mobSheetHintBtn.addEventListener('click', () => {
      const on = this.actions.onToggleTerritoryHint();
      this.hintBtn.classList.toggle('btn-active', on);
      this.mobSheetHintBtn.classList.toggle('btn-active', on);
      this.mobMoreSheetEl.classList.add('hidden');
    });
    this.root.querySelector('#mob-sheet-stir')!.addEventListener('click', () => {
      this.actions.onStirBowls();
      this.mobMoreSheetEl.classList.add('hidden');
    });
    this.root.querySelector('#mob-sheet-nick')!.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
      this.nickModalInputEl.value = this.currentNickname;
      this.nickModalEl.classList.remove('hidden');
      this.nickModalInputEl.focus();
    });
    this.root.querySelector('#mob-sheet-save-sgf')!.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
      this.actions.onSaveSgf();
    });
    this.root.querySelector('#mob-sheet-open-sgf')!.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
      this.actions.onOpenSgf();
    });
    this.mobSheetResultBtn.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
      this.resultModalEl.classList.remove('hidden');
    });
    this.mobSheetResignBtn.addEventListener('click', () => {
      this.mobMoreSheetEl.classList.add('hidden');
      this.actions.onResign();
    });

    // Nickname controls (Top bar modal + Setup bar)
    this.root.querySelector('#btn-profile-nick')!.addEventListener('click', () => {
      this.nickModalInputEl.value = this.currentNickname;
      this.nickModalEl.classList.remove('hidden');
      this.nickModalInputEl.focus();
      this.nickModalInputEl.select();
    });
    const closeNickModal = () => this.nickModalEl.classList.add('hidden');
    this.root.querySelector('#btn-close-nick')!.addEventListener('click', closeNickModal);
    this.root.querySelector('#btn-cancel-nick')!.addEventListener('click', closeNickModal);
    this.root.querySelector('#btn-modal-nick-random')!.addEventListener('click', () => {
      this.nickModalInputEl.value = this.actions.onGenerateRandomNickname();
    });
    const commitModalNick = () => {
      const saved = this.actions.onSaveNickname(this.nickModalInputEl.value);
      this.setNicknameDisplay(saved);
      closeNickModal();
      this.showToast(`닉네임이 '${saved}'(으)로 설정되었습니다.`);
    };
    this.root.querySelector('#btn-save-nick')!.addEventListener('click', commitModalNick);
    this.nickModalInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitModalNick();
    });

    this.root.querySelector('#btn-setup-nick-random')!.addEventListener('click', () => {
      const generated = this.actions.onGenerateRandomNickname();
      this.setupNickInputEl.value = generated;
      const saved = this.actions.onSaveNickname(generated);
      this.setNicknameDisplay(saved);
      this.showToast(`새 닉네임 '${saved}' 적용 완료`);
    });
    const commitSetupNick = () => {
      const saved = this.actions.onSaveNickname(this.setupNickInputEl.value);
      this.setNicknameDisplay(saved);
      this.showToast(`닉네임이 '${saved}'(으)로 저장되었습니다.`);
    };
    this.root.querySelector('#btn-setup-nick-save')!.addEventListener('click', commitSetupNick);
    this.setupNickInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitSetupNick();
    });

    // Bottom dock buttons
    this.passBtn.addEventListener('click', () => this.actions.onPass());
    this.undoBtn.addEventListener('click', () => this.actions.onUndo());
    this.resignBtn.addEventListener('click', () => this.actions.onResign());

    // Online Chat / Emotes (Role-isolated persistent panel)
    this.chatToggleBtn.addEventListener('click', () => {
      const hidden = this.chatPopoverEl.classList.toggle('hidden');
      this.chatToggleBtn.classList.toggle('btn-active', !hidden);
      if (!hidden) {
        this.chatUnreadCount = 0;
        this.syncChatUnreadBadge();
        this.chatInputEl.focus();
      }
    });
    this.root.querySelector('#btn-close-chat')!.addEventListener('click', () => {
      this.chatPopoverEl.classList.add('hidden');
      this.chatToggleBtn.classList.remove('btn-active');
    });
    this.quickEmotesGridEl.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-emote]');
      if (!chip) return;
      const text = chip.dataset.emote || '';
      if (text) {
        this.actions.onSendOnlineChat(text);
      }
    });
    const sendChatInput = () => {
      const val = this.chatInputEl.value.trim();
      if (!val) return;
      this.actions.onSendOnlineChat(val);
      this.chatInputEl.value = '';
      this.chatInputEl.focus();
    };
    this.root.querySelector('#btn-send-chat')!.addEventListener('click', sendChatInput);
    this.chatInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatInput();
    });

    this.aiHintBtn.addEventListener('click', () => {
      this.actions.onRequestAIHint();
    });

    this.hintBtn.addEventListener('click', () => {
      const on = this.actions.onToggleTerritoryHint();
      this.hintBtn.classList.toggle('btn-active', on);
    });

    this.moveNumBtn.addEventListener('click', () => {
      const on = this.actions.onToggleMoveNumbers();
      this.moveNumBtn.classList.toggle('btn-active', on);
    });

    this.coordsBtn.addEventListener('click', () => {
      const on = this.actions.onToggleCoordinates();
      this.coordsBtn.classList.toggle('btn-active', on);
    });

    // Pending Move Confirmation Bar
    this.root.querySelector('#btn-nudge-left')!.addEventListener('click', () => this.actions.onNudgePendingMove(-1, 0));
    this.root.querySelector('#btn-nudge-right')!.addEventListener('click', () => this.actions.onNudgePendingMove(1, 0));
    this.root.querySelector('#btn-nudge-up')!.addEventListener('click', () => this.actions.onNudgePendingMove(0, -1));
    this.root.querySelector('#btn-nudge-down')!.addEventListener('click', () => this.actions.onNudgePendingMove(0, 1));
    this.root.querySelector('#btn-pending-confirm')!.addEventListener('click', () => this.actions.onConfirmPendingMove());
    this.root.querySelector('#btn-pending-cancel')!.addEventListener('click', () => this.actions.onCancelPendingMove());

    this.root.querySelector('#btn-save-sgf')!.addEventListener('click', () => this.actions.onSaveSgf());
    this.root.querySelector('#btn-open-sgf')!.addEventListener('click', () => this.actions.onOpenSgf());
    this.showResultBtn.addEventListener('click', () => this.resultModalEl.classList.remove('hidden'));

    // Online prompt accept / decline
    this.root.querySelector('#btn-prompt-accept')!.addEventListener('click', () => {
      const fn = this.promptAcceptHandler;
      this.hideOnlinePrompt();
      if (fn) fn();
    });
    this.root.querySelector('#btn-prompt-decline')!.addEventListener('click', () => {
      const fn = this.promptDeclineHandler;
      this.hideOnlinePrompt();
      if (fn) fn();
    });

    // Scoring agreement banner buttons
    this.confirmScoreBtn.addEventListener('click', () => this.actions.onConfirmScoring());
    this.root.querySelector('#btn-resume-play')!.addEventListener('click', () => this.actions.onResumeFromScoring());

    // Review scrubber controls
    this.reviewSliderEl.addEventListener('input', () => {
      this.actions.onScrubReviewMove(Number(this.reviewSliderEl.value));
    });
    this.root.querySelector('#rev-first')!.addEventListener('click', () => this.actions.onScrubReviewMove(0));
    this.root.querySelector('#rev-prev')!.addEventListener('click', () => {
      this.actions.onScrubReviewMove(Math.max(0, Number(this.reviewSliderEl.value) - 1));
    });
    this.root.querySelector('#rev-next')!.addEventListener('click', () => {
      this.actions.onScrubReviewMove(
        Math.min(Number(this.reviewSliderEl.max), Number(this.reviewSliderEl.value) + 1)
      );
    });
    this.root.querySelector('#rev-last')!.addEventListener('click', () => {
      this.actions.onScrubReviewMove(Number(this.reviewSliderEl.max));
    });

    // Main Mode Tabs (AI / Local 2P / Online)
    this.bindSegmented('#seg-mode', (val) => {
      this.draftMode = val as 'ai' | 'local2p' | 'online';
      const offlineWrap = this.root.querySelector('#offline-options-wrap')!;
      const onlineWrap = this.root.querySelector('#online-lobby-wrap')!;
      const aiPanel = this.root.querySelector('#ai-options-panel')!;

      const isOnline = this.draftMode === 'online';
      offlineWrap.classList.toggle('hidden', isOnline);
      onlineWrap.classList.toggle('hidden', !isOnline);
      aiPanel.classList.toggle('hidden', this.draftMode !== 'ai');

      if (isOnline) {
        this.syncSetupNicknameSilently();
        this.actions.onEnterOnlineTab();
      }
    });

    const syncOfflineGameTypeUI = () => {
      const isOmok = this.draftGameType === 'omok';
      this.root.querySelector('#offline-baduk-rules-sec')!.classList.toggle('hidden', isOmok);
      this.root.querySelector('#offline-baduk-handicap-sec')!.classList.toggle('hidden', isOmok);
      this.root.querySelector('#offline-omok-rules-sec')!.classList.toggle('hidden', !isOmok);

      const sizeBtns = this.root.querySelectorAll<HTMLButtonElement>('#seg-size .seg-btn');
      sizeBtns.forEach((b) => {
        const val = Number(b.dataset.val);
        const visible = isOmok ? val === 15 || val === 19 : val === 19 || val === 13 || val === 9;
        b.classList.toggle('hidden', !visible);
      });

      if (isOmok && this.draftSize !== 15 && this.draftSize !== 19) {
        this.draftSize = 15;
      } else if (!isOmok && this.draftSize === 15) {
        this.draftSize = 19;
      }
      sizeBtns.forEach((b) => b.classList.toggle('selected', Number(b.dataset.val) === this.draftSize));

      const descMap = isOmok ? OMOK_AI_LEVEL_DESCRIPTIONS : AI_LEVEL_DESCRIPTIONS;
      this.root.querySelector('#ai-desc-hint')!.textContent = descMap[this.draftDifficulty];
    };

    this.bindSegmented('#seg-game-type', (val) => {
      this.draftGameType = val as GameType;
      this.draftSize = this.draftGameType === 'omok' ? 15 : 19;
      syncOfflineGameTypeUI();
    });

    this.bindSegmented('#seg-omok-ruleset', (val) => {
      this.draftOmokRuleset = val as OmokRulesetType;
    });

    // Offline segmented controls
    this.bindSegmented('#seg-difficulty', (val) => {
      this.draftDifficulty = Number(val) as AIDifficulty;
      const descMap = this.draftGameType === 'omok' ? OMOK_AI_LEVEL_DESCRIPTIONS : AI_LEVEL_DESCRIPTIONS;
      this.root.querySelector('#ai-desc-hint')!.textContent = descMap[this.draftDifficulty];
    });
    this.bindSegmented('#seg-color', (val) => {
      this.draftColorChoice = val as 'black' | 'white' | 'random';
    });
    this.bindSegmented('#seg-size', (val) => {
      this.draftSize = Number(val) as BoardSize;
    });

    const komiInput = this.root.querySelector('#inp-komi') as HTMLInputElement;
    const handicapSelect = this.root.querySelector('#sel-handicap') as HTMLSelectElement;
    const syncDefaultKomi = () => {
      this.draftKomi = this.draftHandicap >= 2 ? 0.5 : this.draftRuleset === 'korean' ? 6.5 : 7.5;
      komiInput.value = String(this.draftKomi);
    };

    this.bindSegmented('#seg-ruleset', (val) => {
      this.draftRuleset = val as RulesetType;
      syncDefaultKomi();
    });
    handicapSelect.addEventListener('change', () => {
      this.draftHandicap = Number(handicapSelect.value);
      syncDefaultKomi();
    });
    komiInput.addEventListener('change', () => {
      const parsed = parseFloat(komiInput.value);
      if (!Number.isNaN(parsed)) this.draftKomi = parsed;
    });

    const timeSelect = this.root.querySelector('#sel-time') as HTMLSelectElement;
    timeSelect.addEventListener('change', () => {
      this.draftTimePreset = timeSelect.value;
    });

    this.root.querySelector('#btn-start-game')!.addEventListener('click', () => {
      this.submitOfflineGame();
    });

    // Online Sub-tabs (Quick Match / Create Room / Join Room)
    this.bindSegmented('#seg-online-sub', (val) => {
      this.switchOnlineSubTab(val as 'quick' | 'create' | 'join');
    });

    const syncQmGameTypeUI = () => {
      const isOmok = this.qmGameType === 'omok';
      this.root.querySelector('#qm-omok-ruleset-sec')!.classList.toggle('hidden', !isOmok);
      const btns = this.root.querySelectorAll<HTMLButtonElement>('#seg-qm-size .seg-btn');
      btns.forEach((b) => {
        const raw = b.dataset.val!;
        const visible =
          raw === 'any' || (isOmok ? raw === '15' || raw === '19' : raw === '19' || raw === '13' || raw === '9');
        b.classList.toggle('hidden', !visible);
      });
      if (isOmok && this.qmSizePref !== 'any' && this.qmSizePref !== 15 && this.qmSizePref !== 19) {
        this.qmSizePref = 'any';
      } else if (!isOmok && this.qmSizePref === 15) {
        this.qmSizePref = 'any';
      }
      btns.forEach((b) => b.classList.toggle('selected', b.dataset.val === String(this.qmSizePref)));
    };

    this.bindSegmented('#seg-qm-gametype', (val) => {
      this.qmGameType = val as GameType;
      syncQmGameTypeUI();
    });
    this.bindSegmented('#seg-qm-omok-rule', (val) => {
      this.qmOmokRuleset = val as OmokRulesetType;
    });
    this.bindSegmented('#seg-qm-size', (val) => {
      this.qmSizePref = val === 'any' ? 'any' : (Number(val) as BoardSize);
    });

    this.root.querySelector('#btn-qm-start')!.addEventListener('click', () => {
      this.syncSetupNicknameSilently();
      this.actions.onStartQuickMatch(this.qmSizePref, this.qmGameType, this.qmOmokRuleset);
    });
    this.root.querySelector('#btn-qm-cancel')!.addEventListener('click', () => {
      this.actions.onCancelOnlineWait();
    });

    // Online Create Room controls
    this.bindSegmented('#seg-room-vis', (val) => {
      this.roomVis = val as 'public' | 'private';
      this.roomPasswordWrapEl.classList.toggle('hidden', this.roomVis !== 'private');
      if (this.roomVis === 'private') {
        this.roomPasswordInputEl.focus();
      }
    });

    const syncRoomGameTypeUI = () => {
      const isOmok = this.roomGameType === 'omok';
      this.root.querySelector('#room-baduk-rules-sec')!.classList.toggle('hidden', isOmok);
      this.root.querySelector('#room-baduk-handicap-sec')!.classList.toggle('hidden', isOmok);
      this.root.querySelector('#room-omok-rules-sec')!.classList.toggle('hidden', !isOmok);

      const btns = this.root.querySelectorAll<HTMLButtonElement>('#seg-room-size .seg-btn');
      btns.forEach((b) => {
        const v = Number(b.dataset.val);
        const visible = isOmok ? v === 15 || v === 19 : v === 19 || v === 13 || v === 9;
        b.classList.toggle('hidden', !visible);
      });
      if (isOmok && this.roomSize !== 15 && this.roomSize !== 19) {
        this.roomSize = 15;
      } else if (!isOmok && this.roomSize === 15) {
        this.roomSize = 19;
      }
      btns.forEach((b) => b.classList.toggle('selected', Number(b.dataset.val) === this.roomSize));
    };

    this.bindSegmented('#seg-room-gametype', (val) => {
      this.roomGameType = val as GameType;
      this.roomSize = this.roomGameType === 'omok' ? 15 : 19;
      syncRoomGameTypeUI();
    });
    this.bindSegmented('#seg-room-omok-rule', (val) => {
      this.roomOmokRuleset = val as OmokRulesetType;
    });
    this.bindSegmented('#seg-room-size', (val) => {
      this.roomSize = Number(val) as BoardSize;
    });

    const roomKomiInput = this.root.querySelector('#inp-room-komi') as HTMLInputElement;
    const roomHandicapSelect = this.root.querySelector('#sel-room-handicap') as HTMLSelectElement;
    const syncRoomKomi = () => {
      this.roomKomi = this.roomHandicap >= 2 ? 0.5 : this.roomRuleset === 'korean' ? 6.5 : 7.5;
      roomKomiInput.value = String(this.roomKomi);
    };

    this.bindSegmented('#seg-room-rule', (val) => {
      this.roomRuleset = val as RulesetType;
      syncRoomKomi();
    });
    roomHandicapSelect.addEventListener('change', () => {
      this.roomHandicap = Number(roomHandicapSelect.value);
      syncRoomKomi();
    });
    roomKomiInput.addEventListener('change', () => {
      const parsed = parseFloat(roomKomiInput.value);
      if (!Number.isNaN(parsed)) this.roomKomi = parsed;
    });

    const roomTimeSelect = this.root.querySelector('#sel-room-time') as HTMLSelectElement;
    roomTimeSelect.addEventListener('change', () => {
      this.roomTimePreset = roomTimeSelect.value;
    });

    this.bindSegmented('#seg-room-color', (val) => {
      this.roomHostColor = val as 'black' | 'white' | 'random';
    });

    this.root.querySelector('#btn-create-room')!.addEventListener('click', () => {
      this.syncSetupNicknameSilently();
      const titleInput = this.root.querySelector('#inp-room-title') as HTMLInputElement;
      const password = this.roomPasswordInputEl.value.trim();
      if (this.roomVis === 'private' && !password) {
        this.showToast('비공개 대국실 비밀번호를 입력해 주세요.', true);
        this.roomPasswordInputEl.focus();
        return;
      }
      const t = parseTimePreset(this.roomTimePreset);
      this.actions.onCreateOnlineRoom({
        title: titleInput.value.trim(),
        isPublic: this.roomVis === 'public',
        password: this.roomVis === 'private' ? password : undefined,
        boardSize: this.roomSize,
        ruleset: this.roomRuleset,
        gameType: this.roomGameType,
        omokRuleset: this.roomOmokRuleset,
        handicap: this.roomGameType === 'omok' ? 0 : this.roomHandicap,
        komi: this.roomGameType === 'omok' ? 0 : this.roomKomi,
        mainTimeSeconds: t.mainTimeSeconds,
        byoyomiSeconds: t.byoyomiSeconds,
        byoyomiPeriods: t.byoyomiPeriods,
        hostColorPref: this.roomHostColor,
      });
    });

    this.root.querySelector('#btn-copy-code')!.addEventListener('click', () => {
      const code = this.waitingRoomCodeEl.textContent?.trim() || '';
      if (!code) return;
      void navigator.clipboard?.writeText(code);
      this.showToast(`방 코드(${code})가 클립보드에 복사되었습니다.`);
    });

    this.root.querySelector('#btn-copy-invite')!.addEventListener('click', () => {
      const url = this.actions.onGetInviteUrl();
      if (!url) return;
      void navigator.clipboard?.writeText(url);
      this.showToast('초대 링크가 복사되었습니다! 친구에게 전달해 보세요.');
    });

    this.root.querySelector('#btn-cancel-room')!.addEventListener('click', () => {
      this.actions.onCancelOnlineWait();
    });

    // Online Join Room controls
    const triggerJoinByCode = () => {
      this.syncSetupNicknameSilently();
      this.actions.onJoinOnlineRoom(this.joinCodeInputEl.value);
    };
    this.root.querySelector('#btn-join-code')!.addEventListener('click', triggerJoinByCode);
    this.joinCodeInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') triggerJoinByCode();
    });
    this.root.querySelector('#btn-refresh-rooms')!.addEventListener('click', () => {
      this.actions.onRefreshOpenRooms();
    });
    this.bindSegmented('#seg-room-filter', (val) => {
      this.roomFilter = val as 'all' | 'waiting' | 'in_game';
      this.renderOpenRooms(this.cachedOpenRooms);
    });

    // Private Room Password Modal controls
    this.root.querySelector('#btn-close-room-pw')!.addEventListener('click', () => this.closeRoomPasswordModal());
    this.root.querySelector('#btn-cancel-room-pw')!.addEventListener('click', () => this.closeRoomPasswordModal());
    const submitRoomPw = () => {
      if (!this.pendingPasswordPrompt) return;
      const pw = this.passwordModalInputEl.value.trim();
      if (!pw) {
        this.passwordModalErrorEl.textContent = '비밀번호를 입력해 주세요.';
        this.passwordModalErrorEl.classList.remove('hidden');
        this.passwordModalInputEl.focus();
        return;
      }
      const { action, roomCode } = this.pendingPasswordPrompt;
      this.closeRoomPasswordModal();
      this.syncSetupNicknameSilently();
      if (action === 'spectate') {
        this.actions.onSpectateOnlineRoom(roomCode, pw);
      } else {
        this.actions.onJoinOnlineRoom(roomCode, pw);
      }
    };
    this.root.querySelector('#btn-submit-room-pw')!.addEventListener('click', submitRoomPw);
    this.passwordModalInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRoomPw();
    });

    // Result modal buttons
    this.root.querySelector('#btn-close-result')!.addEventListener('click', () => {
      this.resultModalEl.classList.add('hidden');
    });
    this.root.querySelector('#btn-res-review')!.addEventListener('click', () => {
      this.resultModalEl.classList.add('hidden');
      this.actions.onEnterReview();
    });
    this.root.querySelector('#btn-res-sgf')!.addEventListener('click', () => {
      this.actions.onSaveSgf();
    });
    this.rematchResultBtn.addEventListener('click', () => {
      this.actions.onRequestOnlineRematch();
    });
    this.root.querySelector('#btn-res-new')!.addEventListener('click', () => {
      this.resultModalEl.classList.add('hidden');
      this.openSetupModal();
    });

    // Options Modal bindings
    this.root.querySelector('#btn-close-options')!.addEventListener('click', () => this.closeOptionsModal());
    this.root.querySelector('#btn-options-close-footer')!.addEventListener('click', () => this.closeOptionsModal());
    this.root.querySelector('#btn-options-reset')!.addEventListener('click', () => {
      const reset = this.actions.onResetSettings();
      this.syncOptionsDOM(reset);
      this.showToast('옵션이 기본값으로 복원되었습니다.');
    });

    this.bindSegmented('#seg-opt-quality', (val) => {
      const q = val as VisualQuality;
      const presetDefaults =
        q === 'standard'
          ? { bloomEnabled: false, ornateFinishEnabled: false }
          : { bloomEnabled: true, ornateFinishEnabled: true };
      this.syncOptionsDOM(
        this.actions.onUpdateSettings({ visualQuality: q, ...presetDefaults })
      );
    });
    this.bindSegmented('#seg-opt-motion', (val) => {
      this.syncOptionsDOM(this.actions.onUpdateSettings({ stoneMotionStyle: val as StoneMotionStyle }));
    });
    this.bindSegmented('#seg-opt-input', (val) => {
      this.syncOptionsDOM(this.actions.onUpdateSettings({ inputMode: val as PlacementInputMode }));
    });
    this.bindSegmented('#seg-opt-physics', (val) => {
      this.syncOptionsDOM(this.actions.onUpdateSettings({ physicsIntensity: val as PhysicsIntensity }));
    });
    this.bindSegmented('#seg-opt-lighting', (val) => {
      this.syncOptionsDOM(this.actions.onUpdateSettings({ lightingTheme: val as LightingTheme }));
    });
    this.bindSegmented('#seg-opt-ui-layout', (val) => {
      this.syncOptionsDOM(this.actions.onUpdateSettings({ uiLayoutMode: val as UILayoutMode }));
    });
    this.bindSegmented('#seg-opt-grain', (val) => {
      this.syncOptionsDOM(
        this.actions.onUpdateSettings({ boardGrainIntensity: val as BoardGrainIntensity })
      );
    });
    this.bindSegmented('#seg-opt-line-contrast', (val) => {
      this.syncOptionsDOM(
        this.actions.onUpdateSettings({ gridLineContrast: val as GridLineContrast })
      );
    });
    this.root.querySelector('#btn-opt-mobile-visibility')!.addEventListener('click', () => {
      this.syncOptionsDOM(
        this.actions.onUpdateSettings({
          boardGrainIntensity: 'soft',
          gridLineContrast: 'high',
        })
      );
      this.showToast('모바일 선명 격자선 프리셋(은은결 + 고대비)이 적용되었습니다.');
    });
    const brightnessSlider = this.root.querySelector('#slider-opt-brightness') as HTMLInputElement;
    brightnessSlider.addEventListener('input', () => {
      const pct = Number(brightnessSlider.value);
      const lbl = this.root.querySelector('#lbl-opt-brightness');
      if (lbl) lbl.textContent = `${pct}%`;
      this.syncOptionsDOM(this.actions.onUpdateSettings({ lightingBrightness: pct / 100 }));
    });
    this.mobMoreSheetEl.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.mobMoreSheetEl.classList.add('hidden');
      });
    });

    const bindCheckbox = (selector: string, key: keyof UserSettings) => {
      const el = this.root.querySelector(selector) as HTMLInputElement;
      el.addEventListener('change', () => {
        this.syncOptionsDOM(this.actions.onUpdateSettings({ [key]: el.checked } as Partial<UserSettings>));
      });
    };
    bindCheckbox('#opt-bloom', 'bloomEnabled');
    bindCheckbox('#opt-ornate-finish', 'ornateFinishEnabled');
    bindCheckbox('#opt-true-vertical', 'trueVerticalView');
    bindCheckbox('#opt-auto-mobile-vertical', 'autoMobileVerticalView');
    bindCheckbox('#opt-lock-vertical-rot', 'lockVerticalRotation');
    bindCheckbox('#opt-touch-loupe', 'touchLoupeEnabled');
    bindCheckbox('#opt-show-forbidden', 'showForbiddenPoints');
    bindCheckbox('#opt-show-coords', 'showCoordinates');

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.passwordModalEl.classList.contains('hidden')) {
        this.passwordModalEl.classList.add('hidden');
        return;
      }
      if (!this.optionsModalEl.classList.contains('hidden')) {
        this.optionsModalEl.classList.add('hidden');
        return;
      }
      if (!this.tutorialModalEl.classList.contains('hidden')) {
        this.tutorialModalEl.classList.add('hidden');
        return;
      }
      if (!this.setupModalEl.classList.contains('hidden')) {
        this.closeSetupModal();
      }
    });

    this.syncOptionsDOM(this.settings);
  }

  private syncSetupNicknameSilently(): void {
    const raw = this.setupNickInputEl.value.trim();
    if (raw && raw !== this.currentNickname) {
      const saved = this.actions.onSaveNickname(raw);
      this.setNicknameDisplay(saved);
    }
  }

  private switchOnlineSubTab(tab: 'quick' | 'create' | 'join'): void {
    this.onlineSubTab = tab;
    const subGroup = this.root.querySelector('#seg-online-sub')!;
    subGroup.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
      b.classList.toggle('selected', b.dataset.val === tab);
    });

    this.root.querySelector('#online-sub-quick')!.classList.toggle('hidden', tab !== 'quick');
    this.root.querySelector('#online-sub-create')!.classList.toggle('hidden', tab !== 'create');
    this.root.querySelector('#online-sub-join')!.classList.toggle('hidden', tab !== 'join');

    if (tab === 'join') {
      this.actions.onRefreshOpenRooms();
    }
  }

  private bindSegmented(selector: string, onSelect: (val: string) => void): void {
    const group = this.root.querySelector(selector)!;
    const btns = group.querySelectorAll<HTMLButtonElement>('.seg-btn');
    btns.forEach((b) => {
      b.addEventListener('click', () => {
        btns.forEach((other) => other.classList.remove('selected'));
        b.classList.add('selected');
        onSelect(b.dataset.val!);
      });
    });
  }

  private submitOfflineGame(): void {
    this.syncSetupNicknameSilently();

    let humanColor: PlayerColor = BLACK;
    if (this.draftColorChoice === 'white') humanColor = WHITE;
    else if (this.draftColorChoice === 'random') {
      humanColor = Math.random() < 0.5 ? BLACK : WHITE;
    }

    const t = parseTimePreset(this.draftTimePreset);
    const myNick = this.currentNickname;
    const aiLabel = `AI ${AI_LEVEL_NAMES[this.draftDifficulty]} (Lv.${this.draftDifficulty})`;

    const mode = this.draftMode === 'online' ? 'local2p' : this.draftMode;
    const blackName = mode === 'ai' ? (humanColor === BLACK ? myNick : aiLabel) : `${myNick} (흑)`;
    const whiteName = mode === 'ai' ? (humanColor === WHITE ? myNick : aiLabel) : '백 대국자';

    const isOmok = this.draftGameType === 'omok';
    const cfg: GameConfig = {
      boardSize: this.draftSize,
      ruleset: this.draftRuleset,
      gameType: this.draftGameType,
      omokRuleset: this.draftOmokRuleset,
      handicap: isOmok ? 0 : this.draftHandicap,
      komi: isOmok ? 0 : this.draftKomi,
      superko: true,
      mode,
      humanColor,
      aiDifficulty: this.draftDifficulty,
      mainTimeSeconds: t.mainTimeSeconds,
      byoyomiSeconds: t.byoyomiSeconds,
      byoyomiPeriods: t.byoyomiPeriods,
      blackName,
      whiteName,
    };

    this.markGameStartedAndCloseModals();
    this.actions.onStartNewGame(cfg);
  }

  public markGameStartedAndCloseModals(): void {
    this.hasStartedOnce = true;
    this.root.querySelector('#btn-close-setup')!.classList.remove('hidden');
    this.setupModalEl.classList.add('hidden');
    this.resultModalEl.classList.add('hidden');
    this.hideOnlinePrompt();
  }

  public openSetupModal(selectOnlineTab = false): void {
    this.setupNickInputEl.value = this.currentNickname;
    this.setupModalEl.classList.remove('hidden');
    if (selectOnlineTab) {
      const onlineBtn = this.root.querySelector<HTMLButtonElement>('#seg-mode [data-val="online"]');
      onlineBtn?.click();
    }
  }

  public openOnlineJoinWithCode(roomCode: string): void {
    this.openSetupModal(true);
    this.switchOnlineSubTab('join');
    this.joinCodeInputEl.value = roomCode;
  }

  public closeSetupModal(): void {
    this.setupModalEl.classList.add('hidden');
  }

  public setNicknameDisplay(nickname: string): void {
    this.currentNickname = nickname;
    this.topNickLabelEl.textContent = nickname;
    this.setupNickInputEl.value = nickname;
    this.nickModalInputEl.value = nickname;
  }

  public setOnlineTransportState(status: OnlineTransportStatus, brokerLabel: string): void {
    this.onlineStatusDotEl.className = 'status-indicator';
    if (status === 'connected') {
      this.onlineStatusDotEl.classList.add('connected');
      this.onlineStatusTextEl.textContent = `실시간 연결됨 · ${brokerLabel}`;
    } else if (status === 'connecting' || status === 'reconnecting') {
      this.onlineStatusDotEl.classList.add('connecting');
      this.onlineStatusTextEl.textContent = `서버 연결 중... (${brokerLabel})`;
    } else if (status === 'error') {
      this.onlineStatusDotEl.classList.add('error');
      this.onlineStatusTextEl.textContent = `연결 오류 · ${brokerLabel}`;
    } else {
      this.onlineStatusTextEl.textContent = '온라인 대기실 준비';
    }
  }

  public setOnlineLobbyPhase(phase: OnlineSessionPhase): void {
    if (this.qmElapsedTimer !== null && phase !== 'quick_matching') {
      window.clearInterval(this.qmElapsedTimer);
      this.qmElapsedTimer = null;
    }

    if (phase === 'quick_matching') {
      this.qmIdleBoxEl.classList.add('hidden');
      this.qmSearchingBoxEl.classList.remove('hidden');
      this.qmStartTs = Date.now();
      const updateTimer = () => {
        const sec = Math.floor((Date.now() - this.qmStartTs) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        this.qmTimerTextEl.textContent = `상대 대국자를 탐색하는 중... (${mm}:${ss})`;
      };
      updateTimer();
      this.qmElapsedTimer = window.setInterval(updateTimer, 500);
    } else {
      this.qmIdleBoxEl.classList.remove('hidden');
      this.qmSearchingBoxEl.classList.add('hidden');
    }

    if (phase !== 'waiting_room') {
      this.createFormBoxEl.classList.remove('hidden');
      this.waitingRoomBoxEl.classList.add('hidden');
    }

    this.joiningStatusMsgEl.classList.toggle('hidden', phase !== 'joining_room');
  }

  public showWaitingRoom(room: RoomSummary, isPublic: boolean): void {
    this.switchOnlineSubTab('create');
    this.createFormBoxEl.classList.add('hidden');
    this.waitingRoomBoxEl.classList.remove('hidden');
    this.waitingRoomCodeEl.textContent = room.roomCode;
    const isOmok = room.gameType === 'omok';
    const gameLabel = isOmok ? '오목' : '정통 바둑';
    const visLabel = isPublic ? '공개 대기방' : '비공개 코드방';
    if (isOmok) {
      const omokRuleLabel = (room.omokRuleset ?? 'renju') === 'renju' ? '렌주룰' : '자유룰';
      this.waitingRoomMetaEl.textContent = `${visLabel} · ${gameLabel} · ${room.boardSize}줄 · ${omokRuleLabel}`;
    } else {
      const ruleLabel = room.ruleset === 'korean' ? '한국식' : '중국식';
      const hcLabel = room.handicap >= 2 ? `${room.handicap}점 접바둑` : `호선 (덤 ${room.komi}집)`;
      this.waitingRoomMetaEl.textContent = `${visLabel} · ${gameLabel} · ${room.boardSize}줄 · ${ruleLabel} · ${hcLabel}`;
    }
  }

  public updateLivePresence(stats: PresenceStats): void {
    if (!this.webPresenceBadgeEl) return;
    this.webPresenceCountEl.textContent = String(Math.max(1, stats.onlineUsers));
    const parts: string[] = [];
    if (stats.inGameUsers > 0) parts.push(`대국 ${stats.inGameUsers}`);
    if (stats.spectatingUsers > 0) parts.push(`관전 ${stats.spectatingUsers}`);
    if (parts.length > 0) {
      this.webPresenceDetailEl.textContent = `(${parts.join(' · ')})`;
      this.webPresenceDetailEl.classList.remove('hidden');
    } else {
      this.webPresenceDetailEl.classList.add('hidden');
    }
  }

  public promptRoomPassword(
    action: 'join' | 'spectate',
    roomCode: string,
    title?: string,
    errorMsg?: string
  ): void {
    this.pendingPasswordPrompt = { action, roomCode };
    const actionTxt = action === 'spectate' ? '실시간 관전' : '대국 입장';
    this.passwordModalTitleEl.textContent = `비공개방 ${actionTxt}`;
    this.passwordModalDescEl.textContent = title
      ? `'${title}' [${roomCode}] 방의 비밀번호를 입력해 주세요.`
      : `대국방 [${roomCode}]의 비밀번호를 입력해 주세요.`;
    this.passwordModalInputEl.value = '';
    if (errorMsg) {
      this.passwordModalErrorEl.textContent = errorMsg;
      this.passwordModalErrorEl.classList.remove('hidden');
    } else {
      this.passwordModalErrorEl.classList.add('hidden');
      this.passwordModalErrorEl.textContent = '';
    }
    this.passwordModalEl.classList.remove('hidden');
    window.setTimeout(() => this.passwordModalInputEl.focus(), 40);
  }

  public closeRoomPasswordModal(): void {
    this.pendingPasswordPrompt = null;
    this.passwordModalEl.classList.add('hidden');
    this.passwordModalErrorEl.classList.add('hidden');
  }

  public renderOpenRooms(rooms: RoomSummary[]): void {
    this.cachedOpenRooms = rooms;
    const filtered = rooms.filter((r) => {
      if (this.roomFilter === 'waiting') return r.status !== 'in_game';
      if (this.roomFilter === 'in_game') return r.status === 'in_game';
      return true;
    });

    if (filtered.length === 0) {
      const emptyTxt =
        this.roomFilter === 'in_game'
          ? '현재 관전 가능한 진행 중 대국이 없습니다. (대국이 시작되면 목록에 실시간 표시됩니다!)'
          : this.roomFilter === 'waiting'
            ? '현재 대기 중인 대국방이 없습니다. 직접 방을 만들거나 빠른 매칭을 시작해 보세요!'
            : '현재 열린 대국방이 없습니다. 직접 방을 만들거나 빠른 매칭을 시작해 보세요!';
      this.openRoomsListEl.innerHTML = `<div class="empty-rooms-msg">${emptyTxt}</div>`;
      return;
    }

    this.openRoomsListEl.innerHTML = filtered
      .map((r) => {
        const isPrivate = r.hasPassword || !r.isPublic;
        const isLive = r.status === 'in_game';
        const isOmok = r.gameType === 'omok';
        const gameBadge = isOmok
          ? `<span class="room-badge omok">오목</span>`
          : `<span class="room-badge">바둑</span>`;
        const visBadge = isPrivate
          ? `<span class="room-badge private">🔒 비공개</span>`
          : `<span class="room-badge public">공개</span>`;
        const statusBadge = isLive
          ? `<span class="room-badge live">● 대국 중</span>`
          : `<span class="room-badge waiting">대기 중</span>`;
        const ruleTxt = isOmok
          ? (r.omokRuleset ?? 'renju') === 'renju'
            ? '렌주룰'
            : '자유룰'
          : r.ruleset === 'korean'
            ? '한국식'
            : '중국식';
        const hcTxt = isOmok ? '' : r.handicap >= 2 ? ` · ${r.handicap}점` : ` · 덤 ${r.komi}집`;
        const timeTxt =
          r.mainTimeSeconds > 0
            ? `${Math.round(r.mainTimeSeconds / 60)}분+${r.byoyomiSeconds}초`
            : r.byoyomiPeriods > 0
              ? `초읽기 ${r.byoyomiSeconds}초`
              : '무제한';
        const subLine = isLive
          ? `흑 <strong>${escapeHtml(r.blackName || r.hostName)}</strong> vs 백 <strong>${escapeHtml(
              r.whiteName || '대국자'
            )}</strong> · ${r.boardSize}줄 · ${r.moveCount ?? 0}수 진행 · 👁 ${r.spectatorCount ?? 0}명 · [${escapeHtml(
              r.roomCode
            )}]`
          : `방장: <strong>${escapeHtml(r.hostName)}</strong> · ${r.boardSize}줄 · ${ruleTxt}${hcTxt} · ${timeTxt} · [${escapeHtml(
              r.roomCode
            )}]`;

        const actionBtn = isLive
          ? `<button class="btn btn-sm btn-spectate" data-spectate-room="${escapeHtml(r.roomCode)}" data-private="${
              isPrivate ? '1' : '0'
            }" data-title="${escapeHtml(r.title)}">${isPrivate ? '🔒 ' : '👁 '}실시간 관전</button>`
          : `<button class="btn btn-sm btn-gold" data-join-room="${escapeHtml(r.roomCode)}" data-private="${
              isPrivate ? '1' : '0'
            }" data-title="${escapeHtml(r.title)}">${isPrivate ? '🔒 ' : ''}입장하기</button>`;

        const ownCloseBtn = this.actions.isOwnRoom?.(r)
          ? `<button class="btn btn-sm btn-danger" data-close-own-room="${escapeHtml(r.roomCode)}">내 방 닫기</button>`
          : '';

        return `
          <div class="room-item-card${isLive ? ' live-room' : ''}">
            <div style="min-width: 0;">
              <div class="room-item-title">${gameBadge}${visBadge}${statusBadge} ${escapeHtml(r.title)}</div>
              <div class="room-item-sub">${subLine}</div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; justify-content:flex-end;">
              ${actionBtn}
              ${ownCloseBtn}
            </div>
          </div>
        `;
      })
      .join('');

    this.openRoomsListEl.querySelectorAll<HTMLButtonElement>('[data-join-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.joinRoom;
        if (!code) return;
        if (btn.dataset.private === '1') {
          this.promptRoomPassword('join', code, btn.dataset.title);
          return;
        }
        this.syncSetupNicknameSilently();
        this.actions.onJoinOnlineRoom(code);
      });
    });

    this.openRoomsListEl.querySelectorAll<HTMLButtonElement>('[data-spectate-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.spectateRoom;
        if (!code) return;
        if (btn.dataset.private === '1') {
          this.promptRoomPassword('spectate', code, btn.dataset.title);
          return;
        }
        this.syncSetupNicknameSilently();
        this.actions.onSpectateOnlineRoom(code);
      });
    });

    this.openRoomsListEl.querySelectorAll<HTMLButtonElement>('[data-close-own-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.closeOwnRoom;
        if (!code) return;
        this.actions.onCloseOwnRoom?.(code);
      });
    });
  }

  private refreshOnlineHudLabel(): void {
    if (!this.currentOnlineRoomCode) return;
    if (this.onlineSessionRole === 'admin_stealth') {
      this.onlineHudTextEl.textContent = `🛡 은밀 관전 (${this.currentOnlineRoomCode})`;
      if (this.mobOnlineBadgeEl) {
        this.mobOnlineBadgeEl.textContent = `🛡 ${this.currentOnlineRoomCode}`;
      }
      return;
    }
    if (this.onlineSessionRole === 'spectator') {
      this.onlineHudTextEl.textContent = `👁 실시간 관전 (${this.currentOnlineRoomCode}) · 관전자 ${this.currentSpectatorCount}명`;
      if (this.mobOnlineBadgeEl) {
        this.mobOnlineBadgeEl.textContent = `👁 ${this.currentSpectatorCount}`;
      }
      return;
    }
    const stoneTxt = this.currentOnlineMyColor === BLACK ? '흑번' : this.currentOnlineMyColor === WHITE ? '백번' : '';
    const pingPart = typeof this.currentOnlinePingMs === 'number' ? ` · ${this.currentOnlinePingMs}ms` : '';
    const specPart = this.currentSpectatorCount > 0 ? ` · 👁 ${this.currentSpectatorCount}명` : '';
    this.onlineHudTextEl.textContent = `방 ${this.currentOnlineRoomCode}${stoneTxt ? ` (${stoneTxt})` : ''}${pingPart}${specPart}`;
    if (this.mobOnlineBadgeEl) {
      this.mobOnlineBadgeEl.textContent = `${this.currentOnlineRoomCode}${stoneTxt ? `(${stoneTxt[0]})` : ''}`;
    }
  }

  public setOnlineInGameHUD(
    active: boolean,
    roomCode?: string,
    myColor?: PlayerColor,
    sessionRole: OnlineSessionRole = 'player',
    spectatorCount = 0
  ): void {
    this.onlineSessionRole = active ? sessionRole : 'none';
    this.currentOnlineRoomCode = active && roomCode ? roomCode : '';
    this.currentOnlineMyColor = myColor;
    this.currentOnlinePingMs = undefined;
    this.currentSpectatorCount = spectatorCount;

    const isStealth = active && sessionRole === 'admin_stealth';
    const isSpectator = active && (sessionRole === 'spectator' || isStealth);
    this.root.classList.toggle('spectator-mode', isSpectator);
    this.onlineHudPillEl.classList.toggle('hidden', !active);
    this.leaveOnlineBtn.classList.toggle('hidden', !active);
    this.chatToggleBtn.classList.toggle('hidden', !active || isStealth);
    this.leaveOnlineBtn.textContent = isStealth ? '은밀 관전 종료' : isSpectator ? '관전 종료' : '방 나가기';

    if (this.mobOnlineBadgeEl) {
      this.mobOnlineBadgeEl.classList.toggle('hidden', !active);
      this.mobLeaveOnlineBtn.classList.toggle('hidden', !active);
      this.mobChatBtn.classList.toggle('hidden', !active || isStealth);
    }

    const toggleLabel = this.chatToggleBtn.querySelector('#chat-toggle-label');
    if (toggleLabel) {
      toggleLabel.textContent = isSpectator ? '관전자 채팅' : '대국자 채팅';
    }

    this.chatRoleBannerEl.textContent = isSpectator
      ? '👁 관전자 중계 채팅 (경기 당사자에게는 보이지 않습니다)'
      : '🔒 대국자 전용 채팅 (관전자에게는 보이지 않습니다)';
    this.chatRoleBannerEl.classList.toggle('spectator-banner', isSpectator);

    const chips = isSpectator ? SPECTATOR_QUICK_EMOTES : QUICK_EMOTES;
    this.quickEmotesGridEl.innerHTML = chips
      .map((txt) => `<button class="emote-chip" data-emote="${escapeHtml(txt)}">${escapeHtml(txt)}</button>`)
      .join('');

    if (!active) {
      this.chatPopoverEl.classList.add('hidden');
      this.chatToggleBtn.classList.remove('btn-active');
      if (this.mobChatBtn) this.mobChatBtn.classList.remove('btn-active');
      this.clearChatHistory();
      this.hideOnlinePrompt();
    } else {
      this.clearChatHistory();
      this.refreshOnlineHudLabel();
    }
  }

  public updateSpectatorCount(count: number): void {
    this.currentSpectatorCount = Math.max(0, count);
    this.refreshOnlineHudLabel();
  }

  public updateOnlinePing(roomCode: string, myColor: PlayerColor, pingMs: number): void {
    this.currentOnlineRoomCode = roomCode;
    this.currentOnlineMyColor = myColor;
    this.currentOnlinePingMs = pingMs;
    this.refreshOnlineHudLabel();
  }

  public clearChatHistory(): void {
    this.chatUnreadCount = 0;
    this.syncChatUnreadBadge();
    this.chatMessagesListEl.innerHTML =
      '<div class="chat-empty-hint">대화 내용이 여기에 표시됩니다.</div>';
  }

  private syncChatUnreadBadge(): void {
    const label = this.chatUnreadCount > 99 ? '99+' : String(this.chatUnreadCount);
    const hasUnread = this.chatUnreadCount > 0;
    if (this.chatUnreadBadgeEl) {
      this.chatUnreadBadgeEl.textContent = label;
      this.chatUnreadBadgeEl.classList.toggle('hidden', !hasUnread);
    }
    if (this.mobChatBadgeEl) {
      this.mobChatBadgeEl.textContent = label;
      this.mobChatBadgeEl.classList.toggle('hidden', !hasUnread);
    }
  }

  public appendChatMessage(params: {
    channel: 'player' | 'spectator';
    senderName: string;
    text: string;
    isSelf: boolean;
    colorLabel?: string;
  }): void {
    if (
      (params.channel === 'player' && this.onlineSessionRole !== 'player') ||
      (params.channel === 'spectator' && this.onlineSessionRole !== 'spectator')
    ) {
      return;
    }

    const emptyHint = this.chatMessagesListEl.querySelector('.chat-empty-hint');
    if (emptyHint) emptyHint.remove();

    const row = document.createElement('div');
    row.className = `chat-msg-item${params.isSelf ? ' self' : ''}`;
    const tag = params.colorLabel ? `<span class="chat-sender-tag">[${escapeHtml(params.colorLabel)}]</span> ` : '';
    row.innerHTML = `<div class="chat-msg-sender">${tag}${escapeHtml(params.senderName)}</div><div class="chat-msg-text">${escapeHtml(params.text)}</div>`;
    this.chatMessagesListEl.appendChild(row);
    this.chatMessagesListEl.scrollTop = this.chatMessagesListEl.scrollHeight;

    if (!params.isSelf && this.chatPopoverEl.classList.contains('hidden')) {
      this.chatUnreadCount++;
      this.syncChatUnreadBadge();
    }
  }

  public showChatBubble(color: PlayerColor, senderName: string, text: string): void {
    const el = color === BLACK ? this.blackBubbleEl : this.whiteBubbleEl;
    el.textContent = `${senderName}: "${text}"`;
    el.classList.remove('hidden');

    if (this.bubbleTimers[color]) {
      window.clearTimeout(this.bubbleTimers[color]);
    }
    this.bubbleTimers[color] = window.setTimeout(() => {
      el.classList.add('hidden');
    }, 4600);
  }

  public showOnlinePrompt(message: string, onAccept: () => void, onDecline: () => void): void {
    this.onlinePromptTextEl.textContent = message;
    this.promptAcceptHandler = onAccept;
    this.promptDeclineHandler = onDecline;
    this.onlinePromptBannerEl.classList.remove('hidden');
  }

  public hideOnlinePrompt(): void {
    this.onlinePromptBannerEl.classList.add('hidden');
    this.promptAcceptHandler = null;
    this.promptDeclineHandler = null;
  }

  public updateOnlineScoringAgreement(
    isOnline: boolean,
    myColor: PlayerColor | null,
    state: OnlineScoreAgreementState | null
  ): void {
    if (this.onlineSessionRole === 'spectator' && state) {
      const count = (state.blackAgreed ? 1 : 0) + (state.whiteAgreed ? 1 : 0);
      this.confirmScoreBtn.disabled = true;
      this.resumeScoreBtn.disabled = true;
      this.confirmScoreBtn.textContent = `양측 계가 합의 대기 (${count}/2)`;
      this.scoringDescEl.textContent = '관전 모드: 양측 대국자가 사석을 합의·계가 중입니다.';
      return;
    }

    if (!isOnline || !myColor || !state) {
      this.confirmScoreBtn.disabled = false;
      this.resumeScoreBtn.disabled = false;
      this.confirmScoreBtn.textContent = '계가 확정';
      this.scoringDescEl.textContent =
        '반상 위의 죽은 돌(사석)을 클릭해 지정·해제한 뒤 계가를 확정하세요.';
      return;
    }

    const count = (state.blackAgreed ? 1 : 0) + (state.whiteAgreed ? 1 : 0);
    const iAgreed = myColor === BLACK ? state.blackAgreed : state.whiteAgreed;

    this.resumeScoreBtn.disabled = false;
    this.scoringDescEl.textContent =
      '사석을 클릭하면 상대 화면에도 실시간 반영됩니다. 양측 모두 동의하면 계가가 확정됩니다.';

    if (iAgreed) {
      this.confirmScoreBtn.disabled = true;
      this.confirmScoreBtn.textContent = `상대 동의 대기 중 (${count}/2)`;
    } else {
      this.confirmScoreBtn.disabled = false;
      this.confirmScoreBtn.textContent = `계가 동의 (${count}/2)`;
    }
  }

  private getMobileSelfColor(): PlayerColor {
    return this.lastHudConfig?.humanColor === WHITE ? WHITE : BLACK;
  }

  public updateGameHeader(config: GameConfig): void {
    this.lastHudConfig = { ...config };
    const isOmok = config.gameType === 'omok';
    this.brandTitleEl.textContent = isOmok ? '수담 3D 오목' : '수담 3D 바둑';
    if (this.mobTitleEl) {
      this.mobTitleEl.textContent = isOmok ? `오목 ${config.boardSize}` : `바둑 ${config.boardSize}`;
    }

    const isStealth = this.onlineSessionRole === 'admin_stealth';
    const isSpectator = this.onlineSessionRole === 'spectator' || isStealth;

    const modeText = isStealth
      ? '관리자 은밀 관전'
      : isSpectator
        ? '실시간 관전 중계'
        : config.mode === 'ai'
          ? `AI ${AI_LEVEL_NAMES[config.aiDifficulty]}`
          : config.mode === 'online'
            ? `온라인 실시간`
            : '2인 맞대국';

    if (isOmok) {
      const omokRuleText = (config.omokRuleset ?? 'renju') === 'renju' ? '렌주룰(금수)' : '자유룰';
      this.metaBadgeEl.textContent = `오목 ${config.boardSize}줄 · ${omokRuleText} · ${modeText}`;
    } else {
      const ruleText = config.ruleset === 'korean' ? '한국식' : '중국식';
      const hcText = config.handicap >= 2 ? `${config.handicap}점 접바둑` : `덤 ${config.komi}집`;
      this.metaBadgeEl.textContent = `${config.boardSize}줄 · ${ruleText} · ${hcText} · ${modeText}`;
    }

    this.blackNameEl.textContent = config.blackName || '흑 대국자';
    this.whiteNameEl.textContent = config.whiteName || '백 대국자';

    const myTagBlack =
      !isSpectator && config.mode === 'online' ? (config.humanColor === BLACK ? ' · 나' : ' · 상대') : '';
    const myTagWhite =
      !isSpectator && config.mode === 'online' ? (config.humanColor === WHITE ? ' · 나' : ' · 상대') : '';

    if (isOmok) {
      const isRenju = (config.omokRuleset ?? 'renju') === 'renju';
      this.blackSubEl.textContent = (isRenju ? '흑 선공 (3·3/4·4/6목 금수)' : '흑 선공') + myTagBlack;
      this.whiteSubEl.textContent = '백 후공 (금수 없음)' + myTagWhite;
    } else {
      this.blackSubEl.textContent =
        (config.handicap >= 2 ? `치석 ${config.handicap}점` : '흑 선번') + myTagBlack;
      this.whiteSubEl.textContent = `덤 ${config.komi}집` + myTagWhite;
    }

    this.hintBtn.classList.toggle('hidden', isOmok);
    this.passBtn.classList.toggle('hidden', isOmok);
    this.undoBtn.textContent = !isSpectator && config.mode === 'online' ? '무르기 요청' : '무르기';

    if (this.mobOppNameEl && this.mobSelfNameEl) {
      const selfColor = this.getMobileSelfColor();
      const oppColor = selfColor === BLACK ? WHITE : BLACK;
      const blackLabel = config.blackName || '흑 대국자';
      const whiteLabel = config.whiteName || '백 대국자';
      this.mobSelfDotEl.className = `stone-icon ${selfColor === BLACK ? 'black' : 'white'} mob-dot`;
      this.mobOppDotEl.className = `stone-icon ${oppColor === BLACK ? 'black' : 'white'} mob-dot`;
      this.mobSelfNameEl.textContent = selfColor === BLACK ? blackLabel : whiteLabel;
      this.mobOppNameEl.textContent = oppColor === BLACK ? blackLabel : whiteLabel;
      this.mobSheetHintBtn.classList.toggle('hidden', isOmok);
      this.mobPassBtn.classList.toggle('hidden', isOmok);
    }
  }

  public setCoordStatus(text: string): void {
    this.coordBadgeEl.textContent = text;
    if (this.mobCoordBadgeEl) {
      this.mobCoordBadgeEl.textContent = text;
    }
  }

  public updatePlayersStatus(params: {
    turn: PlayerColor;
    phase: GamePhase;
    captures: { black: number; white: number };
    aiThinking: boolean;
    moveCount: number;
    mode?: 'ai' | 'local2p' | 'online';
    humanColor?: PlayerColor;
    gameType?: GameType;
  }): void {
    this.lastHudStatus = { ...params, captures: { ...params.captures } };
    const { turn, phase, captures, aiThinking, moveCount, mode, humanColor, gameType } = params;
    const isOmok = gameType === 'omok';
    this.blackCapturesEl.parentElement!.classList.toggle('hidden', isOmok);
    this.whiteCapturesEl.parentElement!.classList.toggle('hidden', isOmok);
    this.blackCapturesEl.textContent = String(captures.black);
    this.whiteCapturesEl.textContent = String(captures.white);

    const isPlaying = phase === 'playing';
    this.blackCardEl.classList.toggle('active-turn', isPlaying && turn === BLACK);
    this.whiteCardEl.classList.toggle('active-turn', isPlaying && turn === WHITE);

    this.blackTurnPill.textContent = aiThinking && turn === BLACK ? '수읽기 중...' : '착수 차례';
    this.whiteTurnPill.textContent = aiThinking && turn === WHITE ? '수읽기 중...' : '착수 차례';

    const isOnline = mode === 'online';
    const isSpectator =
      this.onlineSessionRole === 'spectator' || this.onlineSessionRole === 'admin_stealth';
    const isMyTurn = !isSpectator && (!isOnline || turn === humanColor);

    this.passBtn.disabled = isSpectator || !isPlaying || aiThinking || !isMyTurn;
    this.undoBtn.disabled = isSpectator || !isPlaying || aiThinking || moveCount === 0;
    this.resignBtn.disabled = isSpectator || !isPlaying || aiThinking;
    this.aiHintBtn.disabled = isSpectator || !isPlaying || aiThinking || !isMyTurn || isOnline;

    this.scoringBannerEl.classList.toggle('hidden', phase !== 'scoring');
    this.showResultBtn.classList.toggle('hidden', phase !== 'finished' && phase !== 'review');

    if (this.mobSelfCardEl && this.mobOppCardEl) {
      const selfColor = this.getMobileSelfColor();
      const oppColor = selfColor === BLACK ? WHITE : BLACK;
      this.mobSelfCapEl.textContent = String(selfColor === BLACK ? captures.black : captures.white);
      this.mobOppCapEl.textContent = String(oppColor === BLACK ? captures.black : captures.white);
      this.mobSelfCapEl.parentElement!.classList.toggle('hidden', isOmok);
      this.mobOppCapEl.parentElement!.classList.toggle('hidden', isOmok);
      this.mobSelfCardEl.classList.toggle('active-turn', isPlaying && turn === selfColor);
      this.mobOppCardEl.classList.toggle('active-turn', isPlaying && turn === oppColor);
      this.mobPassBtn.disabled = this.passBtn.disabled;
      this.mobUndoBtn.disabled = this.undoBtn.disabled;
      this.mobSheetResignBtn.disabled = this.resignBtn.disabled;
      this.mobAiHintBtn.disabled = this.aiHintBtn.disabled;
      this.mobSheetResultBtn.classList.toggle('hidden', phase !== 'finished' && phase !== 'review');
    }
  }

  public updateClocks(
    blackText: string,
    whiteText: string,
    blackUrgent: boolean,
    whiteUrgent: boolean
  ): void {
    this.blackClockEl.textContent = blackText;
    this.whiteClockEl.textContent = whiteText;
    this.blackClockEl.classList.toggle('urgent', blackUrgent);
    this.whiteClockEl.classList.toggle('urgent', whiteUrgent);

    if (this.mobSelfClockEl && this.mobOppClockEl) {
      const selfColor = this.getMobileSelfColor();
      const selfIsBlack = selfColor === BLACK;
      this.mobSelfClockEl.textContent = selfIsBlack ? blackText : whiteText;
      this.mobOppClockEl.textContent = selfIsBlack ? whiteText : blackText;
      this.mobSelfClockEl.classList.toggle('urgent', selfIsBlack ? blackUrgent : whiteUrgent);
      this.mobOppClockEl.classList.toggle('urgent', selfIsBlack ? whiteUrgent : blackUrgent);
    }
  }

  public updateScoringBannerTally(score: ScoreBreakdown): void {
    const leader =
      score.winner === BLACK
        ? `흑 +${score.margin}집 우세`
        : score.winner === WHITE
          ? `백 +${score.margin}집 우세`
          : '동점';
    this.scoringTallyEl.textContent = `흑 ${score.blackTotal} vs 백 ${score.whiteTotal} (${leader})`;
  }

  public setHintButtonActive(active: boolean): void {
    this.hintBtn.classList.toggle('btn-active', active);
    if (this.mobSheetHintBtn) {
      this.mobSheetHintBtn.classList.toggle('btn-active', active);
    }
  }

  public setMoveNumbersButtonActive(active: boolean): void {
    this.moveNumBtn.classList.toggle('btn-active', active);
    if (this.mobSheetNumsBtn) {
      this.mobSheetNumsBtn.classList.toggle('btn-active', active);
    }
  }

  public configureReviewBar(
    visible: boolean,
    currentMove: number,
    totalMoves: number,
    blackWinrates?: Array<number | undefined>
  ): void {
    this.reviewBarEl.classList.toggle('hidden', !visible);
    this.reviewSliderEl.max = String(totalMoves);
    this.reviewSliderEl.value = String(currentMove);
    this.reviewLabelEl.textContent = `${currentMove} / ${totalMoves}수`;

    const chartWrap = this.root.querySelector('#rev-chart-wrap');
    if (chartWrap) {
      const hasAnyData = Boolean(
        visible && blackWinrates && blackWinrates.some((v) => typeof v === 'number' && !Number.isNaN(v))
      );
      chartWrap.classList.toggle('hidden', !hasAnyData);
      if (hasAnyData && blackWinrates) {
        this.renderWinrateSparkline(blackWinrates, currentMove, totalMoves);
      }
    }
  }

  private renderWinrateSparkline(
    blackWinrates: Array<number | undefined>,
    currentMove: number,
    totalMoves: number
  ): void {
    const canvas = this.reviewChartCanvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 50% baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const pts: Array<{ x: number; y: number; wr: number; move: number }> = [];
    for (let i = 0; i <= totalMoves; i++) {
      const wr = blackWinrates[i];
      if (typeof wr !== 'number' || Number.isNaN(wr)) continue;
      const clamped = Math.max(0, Math.min(1, wr));
      const x = totalMoves > 0 ? (i / totalMoves) * (w - 8) + 4 : 4;
      const y = h - 4 - clamped * (h - 8);
      pts.push({ x, y, wr: clamped, move: i });
    }

    if (pts.length >= 1) {
      ctx.strokeStyle = '#6fe09a';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }

    // Current scrubber position marker
    const curX = totalMoves > 0 ? (currentMove / totalMoves) * (w - 8) + 4 : 4;
    ctx.strokeStyle = '#e6b85c';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(curX, 2);
    ctx.lineTo(curX, h - 2);
    ctx.stroke();

    let latestWr: number | undefined = blackWinrates[currentMove];
    if (latestWr === undefined) {
      for (let i = Math.min(currentMove, totalMoves); i >= 0; i--) {
        if (typeof blackWinrates[i] === 'number') {
          latestWr = blackWinrates[i];
          break;
        }
      }
    }
    if (this.reviewWinrateLabelEl) {
      this.reviewWinrateLabelEl.textContent =
        typeof latestWr === 'number' ? `흑 ${(latestWr * 100).toFixed(1)}%` : '--%';
    }
  }

  public showResultModal(result: GameResult, config: GameConfig): void {
    const isOmok = config.gameType === 'omok';
    const sb = result.scoreBreakdown;
    const ruleName = isOmok
      ? (config.omokRuleset ?? 'renju') === 'renju'
        ? '오목 렌주룰'
        : '오목 자유룰'
      : config.ruleset === 'korean'
        ? '한국식 계가 (집 + 사석)'
        : '중국식 계가 (생존돌 + 집 면적)';

    const bName = escapeHtml(config.blackName || '흑');
    const wName = escapeHtml(config.whiteName || '백');

    let detailTable = '';
    if (!isOmok && sb) {
      if (sb.ruleset === 'korean') {
        detailTable = `
          <table class="score-table">
            <thead>
              <tr>
                <th>항목 (${ruleName})</th>
                <th>흑 (${bName})</th>
                <th>백 (${wName})</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>영역 (집)</td>
                <td>${sb.blackTerritory}집</td>
                <td>${sb.whiteTerritory}집</td>
              </tr>
              <tr>
                <td>대국 중 따낸 사석</td>
                <td>${sb.blackCapturesDuringPlay}개</td>
                <td>${sb.whiteCapturesDuringPlay}개</td>
              </tr>
              <tr>
                <td>종국 시 사석 수거</td>
                <td>+${sb.deadWhiteStones}개</td>
                <td>+${sb.deadBlackStones}개</td>
              </tr>
              <tr>
                <td>덤 (Komi)</td>
                <td>—</td>
                <td>+${sb.komi}집</td>
              </tr>
              <tr class="total-row">
                <td>최종 합계</td>
                <td>${sb.blackTotal}집</td>
                <td>${sb.whiteTotal}집</td>
              </tr>
            </tbody>
          </table>
        `;
      } else {
        detailTable = `
          <table class="score-table">
            <thead>
              <tr>
                <th>항목 (${ruleName})</th>
                <th>흑 (${bName})</th>
                <th>백 (${wName})</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>반상 위 살아있는 돌</td>
                <td>${sb.blackAliveStones}개</td>
                <td>${sb.whiteAliveStones}개</td>
              </tr>
              <tr>
                <td>둘러싼 빈 집</td>
                <td>${sb.blackTerritory}집</td>
                <td>${sb.whiteTerritory}집</td>
              </tr>
              <tr>
                <td>덤 (Komi)</td>
                <td>—</td>
                <td>+${sb.komi}집</td>
              </tr>
              <tr class="total-row">
                <td>최종 면적 합계</td>
                <td>${sb.blackTotal}점</td>
                <td>${sb.whiteTotal}점</td>
              </tr>
            </tbody>
          </table>
        `;
      }
    }

    this.resultBodyEl.innerHTML = `
      <div class="result-headline">
        <span class="winner-badge">대국 종료${isOmok ? ` · ${ruleName}` : ''}</span>
        <h3>${escapeHtml(result.summaryText)}</h3>
      </div>
      ${detailTable}
    `;

    this.rematchResultBtn.classList.toggle(
      'hidden',
      config.mode !== 'online' || this.onlineSessionRole === 'spectator'
    );
    this.rematchResultBtn.disabled = false;
    this.rematchResultBtn.textContent = '온라인 재대국 신청';

    this.resultModalEl.classList.remove('hidden');
  }

  public setCameraPresetActive(preset: CameraPreset): void {
    this.camPresetBtns.forEach((btn) => {
      btn.classList.toggle('btn-active', btn.dataset.cam === preset);
    });
  }

  public setPendingMoveState(coordLabel: string | null, hintPrefix = '착수 예정'): void {
    const active = coordLabel !== null;
    this.pendingMoveBarEl.classList.toggle('hidden', !active);
    if (coordLabel !== null) {
      this.pendingCoordEl.textContent = `${hintPrefix}: ${coordLabel}`;
    }
  }

  public setAIHintLoading(loading: boolean): void {
    this.aiHintBtn.textContent = loading ? '수읽기 중...' : 'AI 추천수';
    this.aiHintBtn.classList.toggle('btn-active', loading);
  }

  public openOptionsModal(): void {
    this.syncOptionsDOM(this.settings);
    this.optionsModalEl.classList.remove('hidden');
  }

  public closeOptionsModal(): void {
    this.optionsModalEl.classList.add('hidden');
  }

  public syncOptionsDOM(s: UserSettings): void {
    this.settings = { ...s };
    const markSeg = (selector: string, val: string) => {
      this.root.querySelectorAll<HTMLButtonElement>(`${selector} .seg-btn`).forEach((b) => {
        b.classList.toggle('selected', b.dataset.val === val);
      });
    };
    markSeg('#seg-opt-quality', s.visualQuality);
    markSeg('#seg-opt-motion', s.stoneMotionStyle);
    markSeg('#seg-opt-input', s.inputMode);
    markSeg('#seg-opt-physics', s.physicsIntensity);
    markSeg('#seg-opt-lighting', s.lightingTheme);
    markSeg('#seg-opt-ui-layout', s.uiLayoutMode);
    markSeg('#seg-opt-grain', s.boardGrainIntensity);
    markSeg('#seg-opt-line-contrast', s.gridLineContrast);

    const brightnessPct = Math.round((s.lightingBrightness ?? 1) * 100);
    const brightnessSlider = this.root.querySelector('#slider-opt-brightness') as HTMLInputElement | null;
    if (brightnessSlider) brightnessSlider.value = String(brightnessPct);
    const brightnessLbl = this.root.querySelector('#lbl-opt-brightness');
    if (brightnessLbl) brightnessLbl.textContent = `${brightnessPct}%`;

    (this.root.querySelector('#opt-bloom') as HTMLInputElement).checked = s.bloomEnabled;
    (this.root.querySelector('#opt-ornate-finish') as HTMLInputElement).checked = s.ornateFinishEnabled;
    (this.root.querySelector('#opt-true-vertical') as HTMLInputElement).checked = s.trueVerticalView;
    (this.root.querySelector('#opt-auto-mobile-vertical') as HTMLInputElement).checked =
      s.autoMobileVerticalView;
    (this.root.querySelector('#opt-lock-vertical-rot') as HTMLInputElement).checked = s.lockVerticalRotation;
    (this.root.querySelector('#opt-touch-loupe') as HTMLInputElement).checked = s.touchLoupeEnabled;
    (this.root.querySelector('#opt-show-forbidden') as HTMLInputElement).checked = s.showForbiddenPoints;
    (this.root.querySelector('#opt-show-coords') as HTMLInputElement).checked = s.showCoordinates;
    this.coordsBtn.classList.toggle('btn-active', s.showCoordinates);
    if (this.mobSheetCoordsBtn) {
      this.mobSheetCoordsBtn.classList.toggle('btn-active', s.showCoordinates);
    }

    const volSlider = this.root.querySelector('#slider-volume') as HTMLInputElement;
    volSlider.value = String(Math.round(s.soundVolume * 100));
    const muteBtn = this.root.querySelector('#btn-mute') as HTMLButtonElement;
    muteBtn.textContent = s.soundMuted ? '음소거됨' : '음향';
    muteBtn.classList.toggle('btn-danger', s.soundMuted);

    this.applyUiLayoutMode(s.uiLayoutMode);
  }

  public applyUiLayoutMode(mode: UILayoutMode = this.settings.uiLayoutMode): 'desktop' | 'mobile' {
    const effective = resolveEffectiveUiLayout(mode);
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.uiLayout = effective;
    }
    this.root.classList.toggle('mobile-ui-layout', effective === 'mobile');
    if (effective === 'desktop' && this.mobMoreSheetEl) {
      this.mobMoreSheetEl.classList.add('hidden');
    }
    if (this.lastHudConfig) {
      const selfColor = this.getMobileSelfColor();
      const oppColor = selfColor === BLACK ? WHITE : BLACK;
      this.mobSelfDotEl.className = `stone-icon ${selfColor === BLACK ? 'black' : 'white'} mob-dot`;
      this.mobOppDotEl.className = `stone-icon ${oppColor === BLACK ? 'black' : 'white'} mob-dot`;
    }
    if (this.lastHudStatus) {
      const { turn, phase, captures } = this.lastHudStatus;
      const selfColor = this.getMobileSelfColor();
      const oppColor = selfColor === BLACK ? WHITE : BLACK;
      this.mobSelfCapEl.textContent = String(selfColor === BLACK ? captures.black : captures.white);
      this.mobOppCapEl.textContent = String(oppColor === BLACK ? captures.black : captures.white);
      this.mobSelfCardEl.classList.toggle('active-turn', phase === 'playing' && turn === selfColor);
      this.mobOppCardEl.classList.toggle('active-turn', phase === 'playing' && turn === oppColor);
    }
    return effective;
  }

  public updateUrgentCountdown(state: UrgentCountdownState): void {
    if (!this.byoyomiBannerEl || !this.byoyomiPulseEl) return;
    if (!state.active || state.secondsLeft <= 0) {
      this.lastBannerCount = null;
      this.byoyomiPulseEl.classList.add('hidden');
      this.byoyomiPulseEl.classList.remove('critical');
      this.byoyomiBannerEl.classList.add('hidden');
      this.byoyomiBannerEl.classList.remove('critical', 'pop-tick');
      return;
    }

    const isCritical = state.secondsLeft <= 5;
    const playerTxt = state.color === BLACK ? '흑(Black)' : '백(White)';
    this.byoyomiPulseEl.classList.remove('hidden');
    this.byoyomiPulseEl.classList.toggle('critical', isCritical);
    this.byoyomiBannerEl.classList.remove('hidden');
    this.byoyomiBannerEl.classList.toggle('critical', isCritical);

    this.byoyomiBannerNumEl.textContent = String(state.secondsLeft);
    this.byoyomiBannerLabelEl.textContent = state.isByoyomi
      ? `${playerTxt} 초읽기 ${state.secondsLeft}초`
      : `${playerTxt} 제한시간 ${state.secondsLeft}초`;
    this.byoyomiBannerSubEl.textContent = state.isByoyomi
      ? state.periodsLeft <= 1
        ? '마지막 초읽기입니다! 시간 초과 시 패배'
        : `남은 초읽기 ${state.periodsLeft}회`
      : '제한시간이 곧 만료됩니다!';

    if (this.lastBannerCount !== state.secondsLeft) {
      this.lastBannerCount = state.secondsLeft;
      this.byoyomiBannerEl.classList.remove('pop-tick');
      void this.byoyomiBannerEl.offsetWidth;
      this.byoyomiBannerEl.classList.add('pop-tick');
    }
  }

  public openTutorialModal(
    lessons: ReadonlyArray<TutorialLesson>,
    completedIds: ReadonlySet<string>
  ): void {
    this.tutorialProgressSummaryEl.textContent = `완료한 학습: ${completedIds.size} / ${lessons.length}`;
    const basics = lessons.filter(
      (l) => l.category === '기초' || l.category === '규칙' || l.category === '종국 · 계가'
    );
    const tactics = lessons.filter(
      (l) => l.category !== '기초' && l.category !== '규칙' && l.category !== '종국 · 계가'
    );

    const renderGroup = (heading: string, list: TutorialLesson[]) => `
      <div class="tutorial-group">
        <div class="tutorial-group-title">${escapeHtml(heading)}</div>
        <div class="tutorial-cards-row">
          ${list
            .map((lesson) => {
              const done = completedIds.has(lesson.id);
              const badge = lesson.gameType === 'omok' ? '오목 렌주' : `${lesson.boardSize}줄 바둑`;
              return `
                <button class="tutorial-lesson-card${done ? ' completed' : ''}" data-tut-lesson="${escapeHtml(lesson.id)}">
                  <div class="tut-card-top">
                    <span class="tut-card-badge">${escapeHtml(badge)} · ${lesson.steps.length}단계</span>
                    <span class="tut-card-status">${done ? '✓ 완료' : '학습하기 ▶'}</span>
                  </div>
                  <div class="tut-card-title">${escapeHtml(lesson.title)}</div>
                  <div class="tut-card-desc">${escapeHtml(lesson.subtitle)}</div>
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `;

    this.tutorialLessonGridEl.innerHTML =
      renderGroup('바둑 기초 · 규칙 · 계가 입문', basics) +
      renderGroup('사활·맥점 & 오목 렌주룰', tactics);

    this.tutorialLessonGridEl.querySelectorAll<HTMLButtonElement>('[data-tut-lesson]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tutLesson;
        if (!id) return;
        this.closeTutorialModal();
        this.actions.onStartTutorialLesson(id);
      });
    });

    this.tutorialModalEl.classList.remove('hidden');
  }

  public closeTutorialModal(): void {
    this.tutorialModalEl.classList.add('hidden');
  }

  public showTutorialCoach(params: {
    lesson: TutorialLesson;
    step: TutorialStep;
    stepIndex: number;
    feedback: string | null;
    isErrorFeedback?: boolean;
    hintVisible: boolean;
    awaitingNext: boolean;
    isFinalStep: boolean;
  }): void {
    const { lesson, step, stepIndex, feedback, isErrorFeedback, hintVisible, awaitingNext, isFinalStep } =
      params;
    this.tutorialCoachEl.classList.remove('hidden');
    this.tutorialCoachTitleEl.textContent = lesson.title;
    this.tutorialCoachStepEl.textContent = `${stepIndex + 1} / ${lesson.steps.length}단계`;
    this.tutorialCoachTextEl.textContent = step.instruction;

    if (feedback) {
      this.tutorialCoachFeedbackEl.textContent = feedback;
      this.tutorialCoachFeedbackEl.classList.remove('hidden');
      this.tutorialCoachFeedbackEl.classList.toggle('error', Boolean(isErrorFeedback));
    } else {
      this.tutorialCoachFeedbackEl.classList.add('hidden');
    }

    if (hintVisible && step.hintText) {
      this.tutorialCoachHintEl.textContent = `💡 힌트: ${step.hintText}`;
      this.tutorialCoachHintEl.classList.remove('hidden');
    } else {
      this.tutorialCoachHintEl.classList.add('hidden');
    }

    this.tutorialNextBtn.classList.toggle('hidden', !awaitingNext);
    this.tutorialNextBtn.textContent = isFinalStep ? '과정 완료하기 ✓' : '다음 단계 ▶';
  }

  public hideTutorialCoach(): void {
    if (this.tutorialCoachEl) {
      this.tutorialCoachEl.classList.add('hidden');
    }
  }

  public showBanNotice(ban: AdminBanEntry): void {
    const targetLabel =
      ban.targetType === 'both'
        ? '계정 + 접속 IP 동시 차단'
        : ban.targetType === 'ip'
          ? '접속 IP 차단'
          : '계정 ID 차단';
    const remaining = formatBanDurationRemaining(ban.expiresAt);
    this.banModalBodyEl.innerHTML = `
      <div class="ban-alert-badge">🚫 온라인 멀티플레이 접근이 제한되었습니다</div>
      <div class="ban-info-grid">
        <div><span>제한 구분</span><strong>${escapeHtml(targetLabel)}</strong></div>
        <div><span>대상 닉네임</span><strong>${escapeHtml(ban.targetNickname || '알 수 없음')}</strong></div>
        <div><span>남은 기간</span><strong class="ban-duration">${escapeHtml(remaining)}</strong></div>
        <div><span>사유</span><strong>${escapeHtml(ban.reason || '관리자 정책 위반')}</strong></div>
      </div>
      <p class="ban-help-note">오프라인 AI 대국 및 입문 튜토리얼은 계속 이용하실 수 있습니다.</p>
    `;
    this.banModalEl.classList.remove('hidden');
  }

  public setRematchButtonPending(): void {
    this.rematchResultBtn.disabled = true;
    this.rematchResultBtn.textContent = '상대방 수락 대기 중...';
  }

  public resetRematchButton(): void {
    this.rematchResultBtn.disabled = false;
    this.rematchResultBtn.textContent = '온라인 재대국 신청';
  }

  public showToast(message: string, isError = false): void {
    while (this.toastContainerEl.children.length >= 3) {
      this.toastContainerEl.firstElementChild?.remove();
    }
    const item = document.createElement('div');
    item.className = `toast-item${isError ? ' error' : ''}`;
    item.textContent = message;
    this.toastContainerEl.appendChild(item);

    window.setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity 0.25s ease';
      window.setTimeout(() => item.remove(), 260);
    }, 2800);
  }
}
