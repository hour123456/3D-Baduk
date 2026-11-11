import {
  BLACK,
  WHITE,
  AIDifficulty,
  BoardSize,
  GameConfig,
  GamePhase,
  GameResult,
  PlayerColor,
  RulesetType,
  ScoreBreakdown,
} from '../rules/types';
import {
  CreateRoomOptions,
  OnlineScoreAgreementState,
  OnlineSessionPhase,
  OnlineTransportStatus,
  QuickMatchSizePref,
  RoomSummary,
} from '../online/types';
import { CameraPreset } from '../scene/SceneManager';

export interface UIActions {
  onStartNewGame: (config: GameConfig) => void;
  onPass: () => void;
  onUndo: () => void;
  onResign: () => void;
  onToggleMoveNumbers: () => boolean;
  onToggleTerritoryHint: () => boolean;
  onToggleCoordinates: () => boolean;
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
  onStartQuickMatch: (preferredSize: QuickMatchSizePref) => void;
  onCancelOnlineWait: () => void;
  onCreateOnlineRoom: (options: CreateRoomOptions) => void;
  onJoinOnlineRoom: (roomCode: string) => void;
  onGetInviteUrl: () => string;
  onLeaveOnlineMatch: () => void;
  onSendOnlineChat: (text: string) => void;
  onRequestOnlineRematch: () => void;
}

const AI_LEVEL_DESCRIPTIONS: Record<AIDifficulty, string> = {
  1: 'Lv.1 입문 — 기본 따내기와 집 짓기 위주로 두며 입문자도 즐겁게 승리할 수 있습니다.',
  2: 'Lv.2 초급 — 단수 방어와 귀·변 포석의 기초를 갖추어 가벼운 연습 대국에 적합합니다.',
  3: 'Lv.3 중급 — RAVE 탐색과 행마 패턴을 활용하여 자연스러운 포석과 중반 전투를 펼칩니다.',
  4: 'Lv.4 고급 — 축(Ladder)·환격 전술 수읽기가 결합되어 날카로운 전투와 끝내기를 구사합니다.',
  5: 'Lv.5 마스터 — 최대 탐색 예산과 정밀 형세 판단으로 빈틈없는 최상급 수읽기를 선보입니다.',
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

  // Draft setup form state (Offline)
  private draftMode: 'ai' | 'local2p' | 'online' = 'ai';
  private draftDifficulty: AIDifficulty = 3;
  private draftColorChoice: 'black' | 'white' | 'random' = 'black';
  private draftSize: BoardSize = 19;
  private draftRuleset: RulesetType = 'korean';
  private draftHandicap = 0;
  private draftKomi = 6.5;
  private draftTimePreset = '10m_30s';

  // Draft setup form state (Online)
  private onlineSubTab: 'quick' | 'create' | 'join' = 'quick';
  private qmSizePref: QuickMatchSizePref = 'any';
  private roomVis: 'public' | 'private' = 'public';
  private roomSize: BoardSize = 19;
  private roomRuleset: RulesetType = 'korean';
  private roomHandicap = 0;
  private roomKomi = 6.5;
  private roomTimePreset = '10m_30s';
  private roomHostColor: 'black' | 'white' | 'random' = 'random';

  private qmElapsedTimer: number | null = null;
  private qmStartTs = 0;
  private bubbleTimers: { [K in PlayerColor]?: number } = {};

  // DOM Elements
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

  private chatPopoverEl!: HTMLElement;
  private chatToggleBtn!: HTMLButtonElement;
  private chatInputEl!: HTMLInputElement;

  private passBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private resignBtn!: HTMLButtonElement;
  private hintBtn!: HTMLButtonElement;
  private moveNumBtn!: HTMLButtonElement;
  private showResultBtn!: HTMLButtonElement;

  private setupModalEl!: HTMLElement;
  private setupNickInputEl!: HTMLInputElement;
  private nickModalEl!: HTMLElement;
  private nickModalInputEl!: HTMLInputElement;

  private onlineStatusDotEl!: HTMLElement;
  private onlineStatusTextEl!: HTMLElement;
  private qmIdleBoxEl!: HTMLElement;
  private qmSearchingBoxEl!: HTMLElement;
  private qmTimerTextEl!: HTMLElement;
  private createFormBoxEl!: HTMLElement;
  private waitingRoomBoxEl!: HTMLElement;
  private waitingRoomCodeEl!: HTMLElement;
  private waitingRoomMetaEl!: HTMLElement;
  private openRoomsListEl!: HTMLElement;
  private joinCodeInputEl!: HTMLInputElement;
  private joiningStatusMsgEl!: HTMLElement;

  private resultModalEl!: HTMLElement;
  private resultBodyEl!: HTMLElement;
  private rematchResultBtn!: HTMLButtonElement;
  private toastContainerEl!: HTMLElement;
  private hasStartedOnce = false;

  constructor(root: HTMLElement, initialNickname: string, actions: UIActions) {
    this.root = root;
    this.currentNickname = initialNickname;
    this.actions = actions;
    this.buildDOM();
  }

  private buildDOM(): void {
    const emoteButtonsHtml = QUICK_EMOTES.map(
      (txt) => `<button class="emote-chip" data-emote="${escapeHtml(txt)}">${escapeHtml(txt)}</button>`
    ).join('');

    this.root.innerHTML = `
      <!-- Top Header -->
      <div>
        <div class="top-bar">
          <div class="brand-cluster interactive">
            <div class="brand-seal">手談</div>
            <span class="brand-title">수담 3D 바둑</span>
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
            <button class="btn btn-sm" data-cam="top" title="수직 조감도 시점">조감도</button>
            <button class="btn btn-sm" data-cam="cinema" title="입체 사선 시점">입체뷰</button>
            <div class="divider-v"></div>
            <button class="btn btn-sm" id="btn-stir-bowls" title="바둑통 속 바둑돌 잘그락 소리 듣기">바둑통 잘그락</button>
            <div class="volume-wrap">
              <button class="btn btn-sm" id="btn-mute" title="음소거 전환">음향</button>
              <input type="range" class="volume-slider" id="slider-volume" min="0" max="100" value="85" />
            </div>
            <div class="divider-v"></div>
            <button class="btn btn-sm btn-gold" id="btn-open-setup">새 대국 · 온라인</button>
            <button class="btn btn-sm" id="btn-fullscreen" title="전체화면 (F11)">전체화면</button>
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
        <div class="chat-popover hidden" id="chat-popover">
          <div class="quick-emotes-grid">${emoteButtonsHtml}</div>
          <div class="chat-input-row">
            <input
              type="text"
              class="text-input"
              id="inp-online-chat"
              maxlength="60"
              placeholder="수담 메시지 입력 (Enter 전송)"
            />
            <button class="btn btn-gold" id="btn-send-chat">전송</button>
          </div>
        </div>

        <div class="review-bar interactive hidden" id="review-bar">
          <button class="btn btn-sm" id="rev-first" title="초수 전으로">|&lt;</button>
          <button class="btn btn-sm" id="rev-prev" title="이전 수">&lt;</button>
          <input type="range" class="review-slider" id="rev-slider" min="0" max="0" value="0" />
          <button class="btn btn-sm" id="rev-next" title="다음 수">&gt;</button>
          <button class="btn btn-sm" id="rev-last" title="마지막 수">&gt;|</button>
          <span class="review-label" id="rev-label">0 / 0수</span>
        </div>

        <div class="bottom-dock interactive">
          <button class="btn" id="btn-pass">한수쉼 (Pass)</button>
          <button class="btn" id="btn-undo">무르기</button>
          <button class="btn btn-danger" id="btn-resign">기권</button>
          <div class="divider-v"></div>
          <button class="btn hidden" id="btn-chat-toggle">수담 인사·채팅</button>
          <button class="btn" id="btn-territory-hint">형세·집 보기</button>
          <button class="btn" id="btn-move-nums">수순 번호</button>
          <button class="btn btn-active" id="btn-coords">좌표 눈금</button>
          <div class="divider-v"></div>
          <button class="btn" id="btn-save-sgf">기보 저장(SGF)</button>
          <button class="btn" id="btn-open-sgf">기보 열기</button>
          <button class="btn btn-gold hidden" id="btn-show-result">계가 결과표</button>
        </div>
      </div>

      <!-- Toast Notifications -->
      <div class="toast-container" id="toast-container"></div>

      <!-- New Game & Online Multiplayer Setup Modal -->
      <div class="modal-backdrop" id="modal-setup">
        <div class="modal-card modal-wide">
          <div class="modal-header">
            <h2>대국 설정 — 수담(手談)</h2>
            <button class="btn btn-sm hidden" id="btn-close-setup">닫기</button>
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
              <span class="form-label">바둑판 크기</span>
              <div class="seg-group" id="seg-size">
                <button class="seg-btn selected" data-val="19">19줄 (정식 대국)</button>
                <button class="seg-btn" data-val="13">13줄 (중형 전략)</button>
                <button class="seg-btn" data-val="9">9줄 (입문·속기)</button>
              </div>
            </div>

            <div class="form-section">
              <span class="form-label">바둑 규칙 및 계가 방식</span>
              <div class="seg-group" id="seg-ruleset">
                <button class="seg-btn selected" data-val="korean">한국식 규칙 (집 + 사석)</button>
                <button class="seg-btn" data-val="chinese">중국식 규칙 (생존돌 + 집 면적)</button>
              </div>
            </div>

            <div class="form-row-2 form-section">
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
                <div class="form-section">
                  <span class="form-label">선호 바둑판 크기</span>
                  <div class="seg-group" id="seg-qm-size">
                    <button class="seg-btn selected" data-val="any">전체 (가장 빠름)</button>
                    <button class="seg-btn" data-val="19">19줄</button>
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
                      <button class="seg-btn" data-val="private">비공개 코드방</button>
                    </div>
                  </div>
                </div>

                <div class="form-row-2 form-section">
                  <div>
                    <span class="form-label">바둑판 크기</span>
                    <div class="seg-group" id="seg-room-size">
                      <button class="seg-btn selected" data-val="19">19줄</button>
                      <button class="seg-btn" data-val="13">13줄</button>
                      <button class="seg-btn" data-val="9">9줄</button>
                    </div>
                  </div>
                  <div>
                    <span class="form-label">계가 규칙</span>
                    <div class="seg-group" id="seg-room-rule">
                      <button class="seg-btn selected" data-val="korean">한국식</button>
                      <button class="seg-btn" data-val="chinese">중국식</button>
                    </div>
                  </div>
                </div>

                <div class="form-row-2 form-section">
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
                <button class="btn btn-danger" id="btn-cancel-room">대국방 닫기</button>
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
                <span class="form-label" style="margin-bottom: 0;">실시간 공개 대기방 목록</span>
                <button class="btn btn-sm" id="btn-refresh-rooms">목록 새로고침</button>
              </div>
              <div class="open-rooms-list" id="open-rooms-list">
                <div class="empty-rooms-msg">
                  현재 대기 중인 공개방이 없습니다. 직접 방을 만들거나 빠른 매칭을 시작해 보세요!
                </div>
              </div>
            </div>
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
    `;

    this.cacheRefsAndBind();
  }

  private cacheRefsAndBind(): void {
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
    this.scoringDescEl = this.root.querySelector('#scoring-desc-text')!;

    this.onlinePromptBannerEl = this.root.querySelector('#online-prompt-banner')!;
    this.onlinePromptTextEl = this.root.querySelector('#online-prompt-text')!;

    this.reviewBarEl = this.root.querySelector('#review-bar')!;
    this.reviewSliderEl = this.root.querySelector('#rev-slider') as HTMLInputElement;
    this.reviewLabelEl = this.root.querySelector('#rev-label')!;

    this.chatPopoverEl = this.root.querySelector('#chat-popover')!;
    this.chatToggleBtn = this.root.querySelector('#btn-chat-toggle') as HTMLButtonElement;
    this.chatInputEl = this.root.querySelector('#inp-online-chat') as HTMLInputElement;

    this.passBtn = this.root.querySelector('#btn-pass') as HTMLButtonElement;
    this.undoBtn = this.root.querySelector('#btn-undo') as HTMLButtonElement;
    this.resignBtn = this.root.querySelector('#btn-resign') as HTMLButtonElement;
    this.hintBtn = this.root.querySelector('#btn-territory-hint') as HTMLButtonElement;
    this.moveNumBtn = this.root.querySelector('#btn-move-nums') as HTMLButtonElement;
    this.showResultBtn = this.root.querySelector('#btn-show-result') as HTMLButtonElement;

    this.setupModalEl = this.root.querySelector('#modal-setup')!;
    this.setupNickInputEl = this.root.querySelector('#inp-setup-nick') as HTMLInputElement;
    this.nickModalEl = this.root.querySelector('#modal-nickname')!;
    this.nickModalInputEl = this.root.querySelector('#inp-modal-nick') as HTMLInputElement;

    this.onlineStatusDotEl = this.root.querySelector('#online-status-dot')!;
    this.onlineStatusTextEl = this.root.querySelector('#online-status-text')!;
    this.qmIdleBoxEl = this.root.querySelector('#qm-idle-box')!;
    this.qmSearchingBoxEl = this.root.querySelector('#qm-searching-box')!;
    this.qmTimerTextEl = this.root.querySelector('#qm-timer-text')!;
    this.createFormBoxEl = this.root.querySelector('#create-form-box')!;
    this.waitingRoomBoxEl = this.root.querySelector('#waiting-room-box')!;
    this.waitingRoomCodeEl = this.root.querySelector('#waiting-room-code')!;
    this.waitingRoomMetaEl = this.root.querySelector('#waiting-room-meta')!;
    this.openRoomsListEl = this.root.querySelector('#open-rooms-list')!;
    this.joinCodeInputEl = this.root.querySelector('#inp-join-code') as HTMLInputElement;
    this.joiningStatusMsgEl = this.root.querySelector('#joining-status-msg')!;

    this.resultModalEl = this.root.querySelector('#modal-result')!;
    this.resultBodyEl = this.root.querySelector('#result-modal-body')!;
    this.rematchResultBtn = this.root.querySelector('#btn-res-rematch') as HTMLButtonElement;
    this.toastContainerEl = this.root.querySelector('#toast-container')!;

    // Camera preset buttons
    this.root.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.actions.onCameraPreset(btn.dataset.cam as CameraPreset);
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
    this.root.querySelector('#btn-fullscreen')!.addEventListener('click', () => this.actions.onToggleFullscreen());
    this.leaveOnlineBtn.addEventListener('click', () => this.actions.onLeaveOnlineMatch());

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

    // Online Chat / Emotes
    this.chatToggleBtn.addEventListener('click', () => {
      const hidden = this.chatPopoverEl.classList.toggle('hidden');
      this.chatToggleBtn.classList.toggle('btn-active', !hidden);
      if (!hidden) this.chatInputEl.focus();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-emote]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const text = chip.dataset.emote || '';
        if (text) {
          this.actions.onSendOnlineChat(text);
          this.chatPopoverEl.classList.add('hidden');
          this.chatToggleBtn.classList.remove('btn-active');
        }
      });
    });
    const sendChatInput = () => {
      const val = this.chatInputEl.value.trim();
      if (!val) return;
      this.actions.onSendOnlineChat(val);
      this.chatInputEl.value = '';
      this.chatPopoverEl.classList.add('hidden');
      this.chatToggleBtn.classList.remove('btn-active');
    };
    this.root.querySelector('#btn-send-chat')!.addEventListener('click', sendChatInput);
    this.chatInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatInput();
    });

    this.hintBtn.addEventListener('click', () => {
      const on = this.actions.onToggleTerritoryHint();
      this.hintBtn.classList.toggle('btn-active', on);
    });

    this.moveNumBtn.addEventListener('click', () => {
      const on = this.actions.onToggleMoveNumbers();
      this.moveNumBtn.classList.toggle('btn-active', on);
    });

    const coordsBtn = this.root.querySelector('#btn-coords') as HTMLButtonElement;
    coordsBtn.addEventListener('click', () => {
      const on = this.actions.onToggleCoordinates();
      coordsBtn.classList.toggle('btn-active', on);
    });

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

    // Offline segmented controls
    this.bindSegmented('#seg-difficulty', (val) => {
      this.draftDifficulty = Number(val) as AIDifficulty;
      this.root.querySelector('#ai-desc-hint')!.textContent = AI_LEVEL_DESCRIPTIONS[this.draftDifficulty];
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

    this.bindSegmented('#seg-qm-size', (val) => {
      this.qmSizePref = val === 'any' ? 'any' : (Number(val) as BoardSize);
    });

    this.root.querySelector('#btn-qm-start')!.addEventListener('click', () => {
      this.syncSetupNicknameSilently();
      this.actions.onStartQuickMatch(this.qmSizePref);
    });
    this.root.querySelector('#btn-qm-cancel')!.addEventListener('click', () => {
      this.actions.onCancelOnlineWait();
    });

    // Online Create Room controls
    this.bindSegmented('#seg-room-vis', (val) => {
      this.roomVis = val as 'public' | 'private';
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
      const t = parseTimePreset(this.roomTimePreset);
      this.actions.onCreateOnlineRoom({
        title: titleInput.value.trim(),
        isPublic: this.roomVis === 'public',
        boardSize: this.roomSize,
        ruleset: this.roomRuleset,
        handicap: this.roomHandicap,
        komi: this.roomKomi,
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

    const cfg: GameConfig = {
      boardSize: this.draftSize,
      ruleset: this.draftRuleset,
      handicap: this.draftHandicap,
      komi: this.draftKomi,
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
    if (!this.hasStartedOnce) return;
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
    const ruleLabel = room.ruleset === 'korean' ? '한국식' : '중국식';
    const visLabel = isPublic ? '공개 대기방' : '비공개 코드방';
    const hcLabel = room.handicap >= 2 ? `${room.handicap}점 접바둑` : `호선 (덤 ${room.komi}집)`;
    this.waitingRoomMetaEl.textContent = `${visLabel} · ${room.boardSize}줄 · ${ruleLabel} · ${hcLabel}`;
  }

  public renderOpenRooms(rooms: RoomSummary[]): void {
    if (rooms.length === 0) {
      this.openRoomsListEl.innerHTML = `
        <div class="empty-rooms-msg">
          현재 대기 중인 공개방이 없습니다. 직접 방을 만들거나 빠른 매칭을 시작해 보세요!
        </div>
      `;
      return;
    }

    this.openRoomsListEl.innerHTML = rooms
      .map((r) => {
        const ruleTxt = r.ruleset === 'korean' ? '한국식' : '중국식';
        const hcTxt = r.handicap >= 2 ? `${r.handicap}점` : `덤 ${r.komi}집`;
        const timeTxt =
          r.mainTimeSeconds > 0
            ? `${Math.round(r.mainTimeSeconds / 60)}분+${r.byoyomiSeconds}초`
            : r.byoyomiPeriods > 0
              ? `초읽기 ${r.byoyomiSeconds}초`
              : '무제한';
        return `
          <div class="room-item-card">
            <div>
              <div class="room-item-title">${escapeHtml(r.title)}</div>
              <div class="room-item-sub">
                방장: <strong>${escapeHtml(r.hostName)}</strong> · ${r.boardSize}줄 · ${ruleTxt} · ${hcTxt} · ${timeTxt} · 코드 [${escapeHtml(r.roomCode)}]
              </div>
            </div>
            <button class="btn btn-sm btn-gold" data-join-room="${escapeHtml(r.roomCode)}">입장하기</button>
          </div>
        `;
      })
      .join('');

    this.openRoomsListEl.querySelectorAll<HTMLButtonElement>('[data-join-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.joinRoom;
        if (code) {
          this.syncSetupNicknameSilently();
          this.actions.onJoinOnlineRoom(code);
        }
      });
    });
  }

  public setOnlineInGameHUD(active: boolean, roomCode?: string, myColor?: PlayerColor): void {
    this.onlineHudPillEl.classList.toggle('hidden', !active);
    this.leaveOnlineBtn.classList.toggle('hidden', !active);
    this.chatToggleBtn.classList.toggle('hidden', !active);
    if (!active) {
      this.chatPopoverEl.classList.add('hidden');
      this.chatToggleBtn.classList.remove('btn-active');
      this.hideOnlinePrompt();
    } else if (roomCode) {
      const stoneTxt = myColor === BLACK ? '내 돌: 흑' : myColor === WHITE ? '내 돌: 백' : '';
      this.onlineHudTextEl.textContent = `방 ${roomCode}${stoneTxt ? ` · ${stoneTxt}` : ''}`;
    }
  }

  public updateOnlinePing(roomCode: string, myColor: PlayerColor, pingMs: number): void {
    const stoneTxt = myColor === BLACK ? '흑번' : '백번';
    this.onlineHudTextEl.textContent = `방 ${roomCode} (${stoneTxt}) · ${pingMs}ms`;
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
    if (!isOnline || !myColor || !state) {
      this.confirmScoreBtn.disabled = false;
      this.confirmScoreBtn.textContent = '계가 확정';
      this.scoringDescEl.textContent =
        '반상 위의 죽은 돌(사석)을 클릭해 지정·해제한 뒤 계가를 확정하세요.';
      return;
    }

    const count = (state.blackAgreed ? 1 : 0) + (state.whiteAgreed ? 1 : 0);
    const iAgreed = myColor === BLACK ? state.blackAgreed : state.whiteAgreed;

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

  public updateGameHeader(config: GameConfig): void {
    const ruleText = config.ruleset === 'korean' ? '한국식' : '중국식';
    const hcText = config.handicap >= 2 ? `${config.handicap}점 접바둑` : `덤 ${config.komi}집`;
    const modeText =
      config.mode === 'ai'
        ? `AI ${AI_LEVEL_NAMES[config.aiDifficulty]}`
        : config.mode === 'online'
          ? `온라인 실시간`
          : '2인 맞대국';
    this.metaBadgeEl.textContent = `${config.boardSize}줄 · ${ruleText} · ${hcText} · ${modeText}`;

    this.blackNameEl.textContent = config.blackName || '흑 대국자';
    this.whiteNameEl.textContent = config.whiteName || '백 대국자';

    const myTagBlack =
      config.mode === 'online' ? (config.humanColor === BLACK ? ' · 나' : ' · 상대') : '';
    const myTagWhite =
      config.mode === 'online' ? (config.humanColor === WHITE ? ' · 나' : ' · 상대') : '';

    this.blackSubEl.textContent =
      (config.handicap >= 2 ? `치석 ${config.handicap}점` : '흑 선번') + myTagBlack;
    this.whiteSubEl.textContent = `덤 ${config.komi}집` + myTagWhite;

    this.undoBtn.textContent = config.mode === 'online' ? '무르기 요청' : '무르기';
  }

  public setCoordStatus(text: string): void {
    this.coordBadgeEl.textContent = text;
  }

  public updatePlayersStatus(params: {
    turn: PlayerColor;
    phase: GamePhase;
    captures: { black: number; white: number };
    aiThinking: boolean;
    moveCount: number;
    mode?: 'ai' | 'local2p' | 'online';
    humanColor?: PlayerColor;
  }): void {
    const { turn, phase, captures, aiThinking, moveCount, mode, humanColor } = params;
    this.blackCapturesEl.textContent = String(captures.black);
    this.whiteCapturesEl.textContent = String(captures.white);

    const isPlaying = phase === 'playing';
    this.blackCardEl.classList.toggle('active-turn', isPlaying && turn === BLACK);
    this.whiteCardEl.classList.toggle('active-turn', isPlaying && turn === WHITE);

    this.blackTurnPill.textContent = aiThinking && turn === BLACK ? '수읽기 중...' : '착수 차례';
    this.whiteTurnPill.textContent = aiThinking && turn === WHITE ? '수읽기 중...' : '착수 차례';

    const isOnline = mode === 'online';
    const isMyTurn = !isOnline || turn === humanColor;

    this.passBtn.disabled = !isPlaying || aiThinking || !isMyTurn;
    this.undoBtn.disabled = !isPlaying || aiThinking || moveCount === 0;
    this.resignBtn.disabled = !isPlaying || aiThinking;

    this.scoringBannerEl.classList.toggle('hidden', phase !== 'scoring');
    this.showResultBtn.classList.toggle('hidden', phase !== 'finished' && phase !== 'review');
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
  }

  public setMoveNumbersButtonActive(active: boolean): void {
    this.moveNumBtn.classList.toggle('btn-active', active);
  }

  public configureReviewBar(visible: boolean, currentMove: number, totalMoves: number): void {
    this.reviewBarEl.classList.toggle('hidden', !visible);
    this.reviewSliderEl.max = String(totalMoves);
    this.reviewSliderEl.value = String(currentMove);
    this.reviewLabelEl.textContent = `${currentMove} / ${totalMoves}수`;
  }

  public showResultModal(result: GameResult, config: GameConfig): void {
    const sb = result.scoreBreakdown;
    const ruleName =
      config.ruleset === 'korean' ? '한국식 계가 (집 + 사석)' : '중국식 계가 (생존돌 + 집 면적)';

    const bName = escapeHtml(config.blackName || '흑');
    const wName = escapeHtml(config.whiteName || '백');

    let detailTable = '';
    if (sb) {
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
        <span class="winner-badge">대국 종료</span>
        <h3>${escapeHtml(result.summaryText)}</h3>
      </div>
      ${detailTable}
    `;

    this.rematchResultBtn.classList.toggle('hidden', config.mode !== 'online');
    this.rematchResultBtn.disabled = false;
    this.rematchResultBtn.textContent = '온라인 재대국 신청';

    this.resultModalEl.classList.remove('hidden');
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
