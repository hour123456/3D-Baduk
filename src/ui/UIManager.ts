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

export class UIManager {
  private root: HTMLElement;
  private actions: UIActions;

  // Draft setup form state
  private draftMode: 'ai' | 'local2p' = 'ai';
  private draftDifficulty: AIDifficulty = 3;
  private draftColorChoice: 'black' | 'white' | 'random' = 'black';
  private draftSize: BoardSize = 19;
  private draftRuleset: RulesetType = 'korean';
  private draftHandicap = 0;
  private draftKomi = 6.5;
  private draftTimePreset = '10m_30s';

  // DOM Elements
  private metaBadgeEl!: HTMLElement;
  private coordBadgeEl!: HTMLElement;
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

  private scoringBannerEl!: HTMLElement;
  private scoringTallyEl!: HTMLElement;

  private reviewBarEl!: HTMLElement;
  private reviewSliderEl!: HTMLInputElement;
  private reviewLabelEl!: HTMLElement;

  private passBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private resignBtn!: HTMLButtonElement;
  private hintBtn!: HTMLButtonElement;
  private moveNumBtn!: HTMLButtonElement;
  private showResultBtn!: HTMLButtonElement;

  private setupModalEl!: HTMLElement;
  private resultModalEl!: HTMLElement;
  private resultBodyEl!: HTMLElement;
  private toastContainerEl!: HTMLElement;
  private hasStartedOnce = false;

  constructor(root: HTMLElement, actions: UIActions) {
    this.root = root;
    this.actions = actions;
    this.buildDOM();
  }

  private buildDOM(): void {
    this.root.innerHTML = `
      <!-- Top Header -->
      <div>
        <div class="top-bar">
          <div class="brand-cluster interactive">
            <div class="brand-seal">手談</div>
            <span class="brand-title">수담 3D 바둑</span>
            <span class="game-meta-badge" id="ui-meta-badge">19줄 · 한국식 · 덤 6.5집</span>
            <span class="coord-badge" id="ui-coord-badge">대기 중</span>
          </div>

          <div class="top-actions interactive">
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
            <button class="btn btn-sm btn-gold" id="btn-open-setup">새 대국</button>
            <button class="btn btn-sm" id="btn-fullscreen" title="전체화면 (F11)">전체화면</button>
          </div>
        </div>

        <!-- Black & White Player Cards -->
        <div class="players-hud-row">
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

          <div class="center-banner-slot">
            <div class="scoring-banner hidden" id="scoring-banner">
              <div class="scoring-banner-text">
                <h4>사석 지정 및 계가 합의</h4>
                <p>반상 위의 죽은 돌(사석)을 클릭해 지정·해제한 뒤 계가를 확정하세요.</p>
              </div>
              <div class="scoring-live-tally" id="scoring-live-tally">흑 0 vs 백 6.5</div>
              <button class="btn btn-gold" id="btn-confirm-score">계가 확정</button>
              <button class="btn" id="btn-resume-play">대국 재개</button>
            </div>
          </div>

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
        </div>
      </div>

      <!-- Bottom Review Scrubber & Control Dock -->
      <div class="bottom-area">
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

      <!-- New Game Setup Modal -->
      <div class="modal-backdrop" id="modal-setup">
        <div class="modal-card">
          <div class="modal-header">
            <h2>대국 설정 — 수담(手談)</h2>
            <button class="btn btn-sm hidden" id="btn-close-setup">닫기</button>
          </div>

          <div class="form-section">
            <span class="form-label">대국 모드</span>
            <div class="seg-group" id="seg-mode">
              <button class="seg-btn selected" data-val="ai">1인 대국 (인공지능)</button>
              <button class="seg-btn" data-val="local2p">2인 대국 (맞대국)</button>
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

    this.scoringBannerEl = this.root.querySelector('#scoring-banner')!;
    this.scoringTallyEl = this.root.querySelector('#scoring-live-tally')!;

    this.reviewBarEl = this.root.querySelector('#review-bar')!;
    this.reviewSliderEl = this.root.querySelector('#rev-slider') as HTMLInputElement;
    this.reviewLabelEl = this.root.querySelector('#rev-label')!;

    this.passBtn = this.root.querySelector('#btn-pass') as HTMLButtonElement;
    this.undoBtn = this.root.querySelector('#btn-undo') as HTMLButtonElement;
    this.resignBtn = this.root.querySelector('#btn-resign') as HTMLButtonElement;
    this.hintBtn = this.root.querySelector('#btn-territory-hint') as HTMLButtonElement;
    this.moveNumBtn = this.root.querySelector('#btn-move-nums') as HTMLButtonElement;
    this.showResultBtn = this.root.querySelector('#btn-show-result') as HTMLButtonElement;

    this.setupModalEl = this.root.querySelector('#modal-setup')!;
    this.resultModalEl = this.root.querySelector('#modal-result')!;
    this.resultBodyEl = this.root.querySelector('#result-modal-body')!;
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

    // Bottom dock buttons
    this.passBtn.addEventListener('click', () => this.actions.onPass());
    this.undoBtn.addEventListener('click', () => this.actions.onUndo());
    this.resignBtn.addEventListener('click', () => this.actions.onResign());

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

    // Scoring agreement banner buttons
    this.root.querySelector('#btn-confirm-score')!.addEventListener('click', () => this.actions.onConfirmScoring());
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

    // Setup modal segmented buttons
    this.bindSegmented('#seg-mode', (val) => {
      this.draftMode = val as 'ai' | 'local2p';
      const aiPanel = this.root.querySelector('#ai-options-panel')!;
      aiPanel.classList.toggle('hidden', this.draftMode !== 'ai');
    });

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
      if (this.draftHandicap >= 2) {
        this.draftKomi = 0.5;
      } else {
        this.draftKomi = this.draftRuleset === 'korean' ? 6.5 : 7.5;
      }
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
      this.submitNewGame();
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
    this.root.querySelector('#btn-res-new')!.addEventListener('click', () => {
      this.resultModalEl.classList.add('hidden');
      this.openSetupModal();
    });
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

  private submitNewGame(): void {
    let humanColor: PlayerColor = BLACK;
    if (this.draftColorChoice === 'white') humanColor = WHITE;
    else if (this.draftColorChoice === 'random') {
      humanColor = Math.random() < 0.5 ? BLACK : WHITE;
    }

    let mainTimeSeconds = 600;
    let byoyomiSeconds = 30;
    let byoyomiPeriods = 3;

    switch (this.draftTimePreset) {
      case '5m_30s':
        mainTimeSeconds = 300;
        byoyomiSeconds = 30;
        byoyomiPeriods = 3;
        break;
      case '10m_30s':
        mainTimeSeconds = 600;
        byoyomiSeconds = 30;
        byoyomiPeriods = 3;
        break;
      case '20m_40s':
        mainTimeSeconds = 1200;
        byoyomiSeconds = 40;
        byoyomiPeriods = 3;
        break;
      case '0m_30s':
        mainTimeSeconds = 0;
        byoyomiSeconds = 30;
        byoyomiPeriods = 3;
        break;
      case 'unlimited':
        mainTimeSeconds = 0;
        byoyomiSeconds = 0;
        byoyomiPeriods = 0;
        break;
    }

    const aiLabel = `AI ${AI_LEVEL_NAMES[this.draftDifficulty]} (Lv.${this.draftDifficulty})`;
    const blackName =
      this.draftMode === 'ai' ? (humanColor === BLACK ? '플레이어 (흑)' : aiLabel) : '흑 대국자';
    const whiteName =
      this.draftMode === 'ai' ? (humanColor === WHITE ? '플레이어 (백)' : aiLabel) : '백 대국자';

    const cfg: GameConfig = {
      boardSize: this.draftSize,
      ruleset: this.draftRuleset,
      handicap: this.draftHandicap,
      komi: this.draftKomi,
      superko: true,
      mode: this.draftMode,
      humanColor,
      aiDifficulty: this.draftDifficulty,
      mainTimeSeconds,
      byoyomiSeconds,
      byoyomiPeriods,
      blackName,
      whiteName,
    };

    this.hasStartedOnce = true;
    this.root.querySelector('#btn-close-setup')!.classList.remove('hidden');
    this.closeSetupModal();
    this.resultModalEl.classList.add('hidden');
    this.actions.onStartNewGame(cfg);
  }

  public openSetupModal(): void {
    this.setupModalEl.classList.remove('hidden');
  }

  public closeSetupModal(): void {
    if (!this.hasStartedOnce) return;
    this.setupModalEl.classList.add('hidden');
  }

  public updateGameHeader(config: GameConfig): void {
    const ruleText = config.ruleset === 'korean' ? '한국식' : '중국식';
    const hcText = config.handicap >= 2 ? `${config.handicap}점 접바둑` : `덤 ${config.komi}집`;
    const modeText =
      config.mode === 'ai' ? `AI ${AI_LEVEL_NAMES[config.aiDifficulty]}` : '2인 맞대국';
    this.metaBadgeEl.textContent = `${config.boardSize}줄 · ${ruleText} · ${hcText} · ${modeText}`;

    this.blackNameEl.textContent = config.blackName || '흑 대국자';
    this.whiteNameEl.textContent = config.whiteName || '백 대국자';
    this.blackSubEl.textContent = config.handicap >= 2 ? `치석 ${config.handicap}점` : '흑 선번';
    this.whiteSubEl.textContent = `덤 ${config.komi}집`;
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
  }): void {
    const { turn, phase, captures, aiThinking, moveCount } = params;
    this.blackCapturesEl.textContent = String(captures.black);
    this.whiteCapturesEl.textContent = String(captures.white);

    const isPlaying = phase === 'playing';
    this.blackCardEl.classList.toggle('active-turn', isPlaying && turn === BLACK);
    this.whiteCardEl.classList.toggle('active-turn', isPlaying && turn === WHITE);

    this.blackTurnPill.textContent = aiThinking && turn === BLACK ? '수읽기 중...' : '착수 차례';
    this.whiteTurnPill.textContent = aiThinking && turn === WHITE ? '수읽기 중...' : '착수 차례';

    this.passBtn.disabled = !isPlaying || aiThinking;
    this.undoBtn.disabled = !isPlaying || aiThinking || moveCount === 0;
    this.resignBtn.disabled = !isPlaying || aiThinking;

    this.scoringBannerEl.classList.toggle('hidden', phase !== 'scoring');
    this.showResultBtn.classList.toggle('hidden', phase !== 'finished' && phase !== 'review');
  }

  public updateClocks(blackText: string, whiteText: string, blackUrgent: boolean, whiteUrgent: boolean): void {
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
    const ruleName = config.ruleset === 'korean' ? '한국식 계가 (집 + 사석)' : '중국식 계가 (생존돌 + 집 면적)';

    let detailTable = '';
    if (sb) {
      if (sb.ruleset === 'korean') {
        detailTable = `
          <table class="score-table">
            <thead>
              <tr>
                <th>항목 (${ruleName})</th>
                <th>흑 (${config.blackName || '흑'})</th>
                <th>백 (${config.whiteName || '백'})</th>
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
                <th>흑 (${config.blackName || '흑'})</th>
                <th>백 (${config.whiteName || '백'})</th>
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
        <h3>${result.summaryText}</h3>
      </div>
      ${detailTable}
    `;

    this.resultModalEl.classList.remove('hidden');
  }

  public showToast(message: string, isError = false): void {
    while (this.toastContainerEl.children.length >= 2) {
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
    }, 2400);
  }
}
