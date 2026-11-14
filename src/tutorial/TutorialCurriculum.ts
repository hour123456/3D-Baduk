import { BLACK, WHITE, BoardSize, Coord, GameType, OmokRulesetType, PlayerColor } from '../rules/types';

export interface TutorialSetupStone {
  x: number;
  y: number;
  color: PlayerColor;
}

export type TutorialStepActionType = 'move' | 'pass' | 'mark_dead' | 'confirm_score';

export interface TutorialStepHighlight {
  x: number;
  y: number;
  kind: 'target' | 'warning' | 'info';
}

export interface TutorialStep {
  id: string;
  stepTitle: string;
  instruction: string;
  actionType: TutorialStepActionType;
  turnColor: PlayerColor;
  setupStones?: TutorialSetupStone[];
  acceptedMoves?: Coord[];
  targetDeadCoord?: Coord;
  initialHighlights?: TutorialStepHighlight[];
  hintCoords?: Coord[];
  hintText: string;
  wrongMoveFeedback: string;
  successFeedback: string;
  opponentReply?: { x: number; y: number; color: PlayerColor } | null;
}

export interface TutorialLesson {
  id: string;
  number: number;
  category: '기초' | '규칙' | '사활 · 맥점' | '종국 · 계가' | '오목 · 렌주';
  title: string;
  subtitle: string;
  estimatedMinutes: number;
  gameType: GameType;
  omokRuleset?: OmokRulesetType;
  boardSize: BoardSize;
  steps: TutorialStep[];
}

export const TUTORIAL_LESSONS: TutorialLesson[] = [
  {
    id: 'lesson-1-liberties',
    number: 1,
    category: '기초',
    title: '교차점과 활로(숨구멍) 기초',
    subtitle: '돌을 어디에 두고, 돌이 살아 숨 쉬는 활로를 어떻게 늘리는지 배웁니다.',
    estimatedMinutes: 1,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l1-s1',
        stepTitle: '교차점에 착수하기',
        instruction:
          '바둑돌은 네모 칸 안이 아니라 가로줄과 세로줄이 만나는 **교차점** 위에 놓습니다. 반상 위 표시된 **화점(★)** 중 한 곳에 흑돌을 놓아보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [],
        acceptedMoves: [
          { x: 2, y: 2 },
          { x: 6, y: 2 },
          { x: 4, y: 4 },
          { x: 2, y: 6 },
          { x: 6, y: 6 },
        ],
        initialHighlights: [
          { x: 2, y: 2, kind: 'target' },
          { x: 6, y: 2, kind: 'target' },
          { x: 4, y: 4, kind: 'target' },
          { x: 2, y: 6, kind: 'target' },
          { x: 6, y: 6, kind: 'target' },
        ],
        hintCoords: [{ x: 4, y: 4 }, { x: 6, y: 2 }],
        hintText: '초록색 고리가 표시된 화점(예: 중앙 E5 또는 우상귀 G7) 교차점을 클릭하세요.',
        wrongMoveFeedback: '지금은 초록색 고리가 표시된 5개의 화점 교차점 중 하나에 놓아보세요.',
        successFeedback: '완벽합니다! 화점 교차점 위에 돌을 놓으면 상하좌우 4방향의 빈 선(활로 4개)을 가집니다.',
      },
      {
        id: 'l1-s2',
        stepTitle: '활로(숨구멍) 늘리기',
        instruction:
          '중앙 흑돌이 백돌 세 개에 둘러싸여 **활로가 딱 1개** 남았습니다! 유일하게 열린 아래쪽 빈 교차점(**E4**)으로 돌을 뻗어(늘기) 숨통을 틔워보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 4, color: BLACK },
          { x: 4, y: 3, color: WHITE },
          { x: 3, y: 4, color: WHITE },
          { x: 5, y: 4, color: WHITE },
        ],
        initialHighlights: [{ x: 4, y: 5, kind: 'info' }],
        acceptedMoves: [{ x: 4, y: 5 }],
        hintCoords: [{ x: 4, y: 5 }],
        hintText: '흑돌 바로 아래쪽 빈 교차점(x=4, y=5 / E4)을 클릭해 돌을 연결해 늘어나세요.',
        wrongMoveFeedback: '지금 다른 곳에 두면 중앙 흑돌이 다음 수에 백에게 잡힙니다. 바로 아래 E4에 두어 활로를 늘리세요!',
        successFeedback: '훌륭해요! 두 흑돌이 연결되면서 활로가 1개에서 3개로 크게 늘어 안전해졌습니다.',
      },
    ],
  },
  {
    id: 'lesson-2-capture',
    number: 2,
    category: '기초',
    title: '단수(Atari)와 상대 돌 따내기',
    subtitle: '상대 돌의 마지막 활로를 막아 들어내는 방법을 익힙니다.',
    estimatedMinutes: 1,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l2-s1',
        stepTitle: '한 돌 따내기',
        instruction:
          '중앙 백돌의 활로가 **1개(단수)**만 남았습니다. 마지막 숨구멍(**E4**)을 막아 백돌을 따내보세요!',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 4, color: WHITE },
          { x: 4, y: 3, color: BLACK },
          { x: 3, y: 4, color: BLACK },
          { x: 5, y: 4, color: BLACK },
        ],
        initialHighlights: [{ x: 4, y: 5, kind: 'info' }],
        acceptedMoves: [{ x: 4, y: 5 }],
        hintCoords: [{ x: 4, y: 5 }],
        hintText: '중앙 백돌 바로 아래 빈 교차점(E4)에 착수하세요.',
        wrongMoveFeedback: '중앙 백돌에 딱 붙어있는 마지막 빈 선(아래쪽 E4)을 메워야 따낼 수 있습니다.',
        successFeedback: '경쾌한 소리와 함께 백돌을 따냈습니다! 따낸 돌은 내 바둑통 뚜껑(사석함)에 모입니다.',
      },
      {
        id: 'l2-s2',
        stepTitle: '연결된 두 돌 한꺼번에 따내기',
        instruction:
          '가로로 연결된 백돌 두 개(**D6-E6**)가 한 몸처럼 묶여 있습니다. 마지막 공통 활로(**E5**)를 막아 두 돌을 동시에 따내보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 3, y: 3, color: WHITE },
          { x: 4, y: 3, color: WHITE },
          { x: 2, y: 3, color: BLACK },
          { x: 5, y: 3, color: BLACK },
          { x: 3, y: 2, color: BLACK },
          { x: 4, y: 2, color: BLACK },
          { x: 3, y: 4, color: BLACK },
        ],
        acceptedMoves: [{ x: 4, y: 4 }],
        hintCoords: [{ x: 4, y: 4 }],
        hintText: '오른쪽 백돌(E6) 바로 아래 교차점(E5)이 두 돌의 마지막 활로입니다.',
        wrongMoveFeedback: '연결된 백돌 두 개의 남은 빈 교차점(E5)을 직접 메워보세요.',
        successFeedback: '정확합니다! 서로 연결된 돌은 활로를 공유하기 때문에, 마지막 1활로가 막히면 통째로 따내집니다.',
      },
    ],
  },
  {
    id: 'lesson-3-connect-cut',
    number: 3,
    category: '기초',
    title: '돌의 연결(잇기)과 끊기',
    subtitle: '내 돌은 튼튼하게 잇고, 상대 돌의 약점은 끊어내는 기본 전술을 배웁니다.',
    estimatedMinutes: 1,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l3-s1',
        stepTitle: '내 돌 단단히 잇기',
        instruction:
          '좌우 흑돌 두 개(**D5, F5**) 사이를 백돌이 노리고 있습니다. 한가운데 교차점(**E5**)에 두어 흑돌들을 하나로 연결하세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 3, y: 4, color: BLACK },
          { x: 5, y: 4, color: BLACK },
          { x: 4, y: 3, color: WHITE },
          { x: 4, y: 5, color: WHITE },
        ],
        acceptedMoves: [{ x: 4, y: 4 }],
        hintCoords: [{ x: 4, y: 4 }],
        hintText: '두 백돌과 두 흑돌이 교차하는 한가운데 E5(x=4, y=4)에 두세요.',
        wrongMoveFeedback: '양쪽 흑돌이 끊기지 않도록 정중앙 E5 자리에 먼저 이어야 합니다.',
        successFeedback: '좋습니다! 서로 이어진 돌은 약해지지 않고 힘을 합쳐 상대의 두 백돌을 양쪽으로 가를 수 있습니다.',
      },
      {
        id: 'l3-s2',
        stepTitle: '상대 돌 끊어가기',
        instruction:
          '이번엔 백돌 두 대오가 틈을 보이고 있습니다! 흑돌(**E7**) 바로 아래 교차점(**E6**)을 끊어 백을 양쪽으로 분리해보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 2, color: BLACK },
          { x: 3, y: 4, color: BLACK },
          { x: 5, y: 4, color: BLACK },
          { x: 3, y: 3, color: WHITE },
          { x: 5, y: 3, color: WHITE },
          { x: 3, y: 2, color: WHITE },
          { x: 5, y: 2, color: WHITE },
        ],
        acceptedMoves: [{ x: 4, y: 3 }],
        hintCoords: [{ x: 4, y: 3 }],
        hintText: '양쪽 백돌 사이 정중앙 E6(x=4, y=3)을 클릭하세요.',
        wrongMoveFeedback: '백돌들이 서로 연결되기 전에 정중앙 급소 E6을 끊어보세요.',
        successFeedback: '완벽한 끊기입니다! 이제 양쪽 백돌이 따로 고립되어 훨씬 불리해졌습니다.',
      },
    ],
  },
  {
    id: 'lesson-4-suicide',
    number: 4,
    category: '규칙',
    title: '착수금지(자충수)와 따내며 살기 예외',
    subtitle: '스스로 죽는 자리는 둘 수 없지만, 동시에 상대를 따내면 착수가 허용됨을 배웁니다.',
    estimatedMinutes: 2,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l4-s1',
        stepTitle: '자충수(착수금지) 이해하기',
        instruction:
          '백돌 넷으로 둘러싸인 중앙 **✕(E5)** 자리는 들어가자마자 활로가 0이 되어 **착수금지(자충수)**입니다. 우선 바깥쪽 백돌의 활로를 줄여(**E7 / C5 / G5 / E3 중 택1**) 압박해보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 3, color: WHITE },
          { x: 3, y: 4, color: WHITE },
          { x: 5, y: 4, color: WHITE },
          { x: 4, y: 5, color: WHITE },
        ],
        initialHighlights: [
          { x: 4, y: 4, kind: 'warning' },
          { x: 4, y: 2, kind: 'info' },
        ],
        acceptedMoves: [
          { x: 4, y: 2 },
          { x: 2, y: 4 },
          { x: 6, y: 4 },
          { x: 4, y: 6 },
        ],
        hintCoords: [{ x: 4, y: 2 }],
        hintText: '빨간 ✕(E5)는 착수금지 자리입니다. 위쪽 백돌 바깥 E7(x=4, y=2)에 두세요.',
        wrongMoveFeedback: 'E5는 자충수라 둘 수 없습니다. 안내된 바깥쪽 교차점(E7 등)으로 압박해보세요.',
        successFeedback: '맞습니다! 자충수 자리에는 마우스를 올리면 붉은 ✕ 금지 표시가 뜹니다.',
      },
      {
        id: 'l4-s2',
        stepTitle: '따내면서 들어가는 예외 규칙!',
        instruction:
          '이제 바깥쪽을 모두 포위해 백돌 4개의 활로가 중앙 한 곳만 남았습니다! 이번에는 한가운데(**E5**)에 놓으면 즉시 백돌 4개를 따내며 살아나므로 **착수가 허용**됩니다. 직접 두어보세요!',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 3, color: WHITE },
          { x: 3, y: 4, color: WHITE },
          { x: 5, y: 4, color: WHITE },
          { x: 4, y: 5, color: WHITE },
          { x: 4, y: 2, color: BLACK },
          { x: 2, y: 4, color: BLACK },
          { x: 6, y: 4, color: BLACK },
          { x: 4, y: 6, color: BLACK },
          { x: 3, y: 3, color: BLACK },
          { x: 5, y: 3, color: BLACK },
          { x: 3, y: 5, color: BLACK },
          { x: 5, y: 5, color: BLACK },
        ],
        acceptedMoves: [{ x: 4, y: 4 }],
        hintCoords: [{ x: 4, y: 4 }],
        hintText: '한가운데 E5(x=4, y=4)를 클릭하면 백돌 4개가 한꺼번에 따내집니다!',
        wrongMoveFeedback: '포위가 끝났으니 이제 정중앙 E5(x=4, y=4)에 직접 들어가 4점을 따내보세요.',
        successFeedback: '대단합니다! 상대 돌을 따내어 활로가 생기면 자충수라도 착수할 수 있습니다.',
      },
    ],
  },
  {
    id: 'lesson-5-ko',
    number: 5,
    category: '규칙',
    title: '패(劫, Ko)의 원리와 팻감 쓰기',
    subtitle: '무한 반복을 막기 위해 바로 되따낼 수 없는 패 규칙과 해소법을 배웁니다.',
    estimatedMinutes: 2,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l5-s1',
        stepTitle: '패(劫)로 한 돌 따내기',
        instruction:
          '중앙 백돌(**E5**)이 단수입니다. **D5(x=3, y=4)**에 착수해 백돌 1점을 따내고 패 모양을 만들어보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 4, y: 4, color: WHITE },
          { x: 2, y: 4, color: WHITE },
          { x: 3, y: 3, color: WHITE },
          { x: 3, y: 5, color: WHITE },
          { x: 4, y: 3, color: BLACK },
          { x: 4, y: 5, color: BLACK },
          { x: 5, y: 4, color: BLACK },
        ],
        acceptedMoves: [{ x: 3, y: 4 }],
        hintCoords: [{ x: 3, y: 4 }],
        hintText: 'D5(x=3, y=4)에 착수해 백돌을 따내세요.',
        wrongMoveFeedback: '지금은 D5 교차점으로 들어가 백돌(E5)을 따내 패를 시작해보세요.',
        successFeedback: '백돌을 따냈습니다! 반상 위에 붉은 마름모(패 금지) 표시가 떴습니다. 백은 바로 이곳을 되따낼 수 없어 다른 곳에 팻감을 씁니다!',
        opponentReply: { x: 7, y: 1, color: WHITE },
      },
      {
        id: 'l5-s2',
        stepTitle: '팻감 이후 패 해소(잇기)',
        instruction:
          '백이 바로 되따낼 수 없어 우상귀에 다른 수(팻감)를 두었습니다. 이번에는 흑이 패를 끝까지 지켜내기 위해 방금 따냈던 자리(**E5**)를 굳혀 **패를 해소**해보세요.',
        actionType: 'move',
        turnColor: BLACK,
        acceptedMoves: [{ x: 4, y: 4 }],
        hintCoords: [{ x: 4, y: 4 }],
        hintText: '원래 백돌이 있던 E5(x=4, y=4) 교차점을 메워 흑돌들을 연결하세요.',
        wrongMoveFeedback: '패를 완전히 내 것으로 확정하려면 E5(x=4, y=4)를 이어서 해소해야 합니다.',
        successFeedback: '완벽합니다! 실제 대국에서는 상대 팻감이 클 때 팻감을 받고(응수하고) 패 싸움을 이어가기도 합니다.',
      },
    ],
  },
  {
    id: 'lesson-6-two-eyes',
    number: 6,
    category: '사활 · 맥점',
    title: '삶과 죽음 — 완전한 두 집(두 눈) 만들기',
    subtitle: '외부의 공격에도 절대 잡히지 않는 완전한 두 집의 원리를 익힙니다.',
    estimatedMinutes: 2,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l6-s1',
        stepTitle: '직삼(直三) 급소에 두어 두 집으로 살기',
        instruction:
          '우상귀 흑돌들이 백에게 완전히 포위되어 있습니다. 흑돌 안쪽 3칸 빈 공간(**G9, H9, J9**) 중 **한가운데 급소(H9 / x=7, y=0)**에 두어 완전한 두 집을 만들어 살아보세요!',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 5, y: 0, color: BLACK },
          { x: 5, y: 1, color: BLACK },
          { x: 6, y: 1, color: BLACK },
          { x: 7, y: 1, color: BLACK },
          { x: 8, y: 1, color: BLACK },
          { x: 4, y: 0, color: WHITE },
          { x: 4, y: 1, color: WHITE },
          { x: 5, y: 2, color: WHITE },
          { x: 6, y: 2, color: WHITE },
          { x: 7, y: 2, color: WHITE },
          { x: 8, y: 2, color: WHITE },
        ],
        initialHighlights: [{ x: 7, y: 0, kind: 'info' }],
        acceptedMoves: [{ x: 7, y: 0 }],
        hintCoords: [{ x: 7, y: 0 }],
        hintText: '맨 윗줄 중앙 H9(x=7, y=0)에 두면 왼쪽 G9와 오른쪽 J9 두 개의 독립된 집이 생깁니다.',
        wrongMoveFeedback: '양 끝(G9, J9)에 두면 백이 H9 치중으로 두 집을 부숴버립니다. 가운데 급소 H9에 두세요!',
        successFeedback: '정확한 사활 급소입니다! 이제 G9와 J9가 완전한 두 집이 되어 백은 어느 쪽에도 착수금지로 들어올 수 없습니다.',
      },
    ],
  },
  {
    id: 'lesson-7-tesuji',
    number: 7,
    category: '사활 · 맥점',
    title: '필수 맥점 — 먹여치기와 환격(Snapback)',
    subtitle: '돌 1개를 먼저 희생(먹여치기)한 뒤 상대 대마를 한꺼번에 되따내는 환격 묘수를 배웁니다.',
    estimatedMinutes: 2,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l7-s1',
        stepTitle: '1단계: 먹여치기(희생타)',
        instruction:
          '우상귀 백돌 4개를 잡을 수 있는 멋진 맥점이 있습니다! 먼저 구석 **J9(x=8, y=0)** 자리에 흑돌 1개를 먹여쳐서 백의 자충을 유도해보세요.',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          { x: 5, y: 0, color: BLACK },
          { x: 5, y: 1, color: BLACK },
          { x: 6, y: 2, color: BLACK },
          { x: 7, y: 2, color: BLACK },
          { x: 8, y: 2, color: BLACK },
          { x: 6, y: 0, color: WHITE },
          { x: 6, y: 1, color: WHITE },
          { x: 7, y: 1, color: WHITE },
          { x: 8, y: 1, color: WHITE },
        ],
        acceptedMoves: [{ x: 8, y: 0 }],
        hintCoords: [{ x: 8, y: 0 }],
        hintText: '맨 오른쪽 구석 교차점 J9(x=8, y=0)에 과감히 먹여치세요.',
        wrongMoveFeedback: '구석 J9(x=8, y=0)에 먼저 돌을 희생해 상대가 5돌 자충 형태로 따내도록 유도해야 합니다.',
        successFeedback: '멋진 먹여치기! 백이 흑돌 1점을 따내더라도 스스로 활로 1개짜리 5돌 덩어리가 됩니다.',
        opponentReply: { x: 7, y: 0, color: WHITE },
      },
      {
        id: 'l7-s2',
        stepTitle: '2단계: 환격으로 5돌 통째로 되따내기!',
        instruction:
          '백이 방금 구석 돌을 따냈지만 **모두 5돌이 연결되어 패 규칙이 적용되지 않고, 남은 활로는 딱 1개(J9)**입니다! **J9**에 다시 착수해 백 5돌을 모두 따내세요!',
        actionType: 'move',
        turnColor: BLACK,
        acceptedMoves: [{ x: 8, y: 0 }],
        hintCoords: [{ x: 8, y: 0 }],
        hintText: '방금 백에게 잡혔던 그 자리 J9(x=8, y=0)를 즉시 다시 두세요!',
        wrongMoveFeedback: '환격에서는 2개 이상의 돌을 잡기 때문에 바로 되따낼 수 있습니다. J9(x=8, y=0)을 클릭하세요!',
        successFeedback: '환격 성공!! 1점을 내주고 5점을 통째로 들어낸 통쾌한 바둑의 꽃입니다.',
      },
    ],
  },
  {
    id: 'lesson-8-scoring',
    number: 8,
    category: '종국 · 계가',
    title: '종국 합의(한수쉼)와 사석 지정·계가법',
    subtitle: '대국 마무리에서 한수쉼으로 종국하고 죽은 돌(사석)을 골라내 집을 계산합니다.',
    estimatedMinutes: 2,
    gameType: 'baduk',
    boardSize: 9,
    steps: [
      {
        id: 'l8-s1',
        stepTitle: '1단계: 한수쉼(Pass)으로 종국하기',
        instruction:
          '왼쪽 흑 집과 오른쪽 백 집의 경계가 모두 완성되었습니다. 더 둘 곳이 없으므로 **한수쉼(Pass)** 버튼을 눌러 종국을 요청하세요.',
        actionType: 'pass',
        turnColor: BLACK,
        setupStones: [
          { x: 3, y: 0, color: BLACK },
          { x: 3, y: 1, color: BLACK },
          { x: 3, y: 2, color: BLACK },
          { x: 3, y: 3, color: BLACK },
          { x: 3, y: 4, color: BLACK },
          { x: 3, y: 5, color: BLACK },
          { x: 3, y: 6, color: BLACK },
          { x: 3, y: 7, color: BLACK },
          { x: 3, y: 8, color: BLACK },
          { x: 1, y: 4, color: WHITE }, // 흑 집 속 사석 1점
          { x: 5, y: 0, color: WHITE },
          { x: 5, y: 1, color: WHITE },
          { x: 5, y: 2, color: WHITE },
          { x: 5, y: 3, color: WHITE },
          { x: 5, y: 4, color: WHITE },
          { x: 5, y: 5, color: WHITE },
          { x: 5, y: 6, color: WHITE },
          { x: 5, y: 7, color: WHITE },
          { x: 5, y: 8, color: WHITE },
        ],
        hintCoords: [],
        hintText: '하단 도크의 [한수쉼] 버튼을 누르면 백도 한수쉼하여 자동으로 사석·계가 단계로 전환됩니다.',
        wrongMoveFeedback: '지금은 바둑판에 두지 말고 아래 [한수쉼] 버튼을 눌러 종국에 합의해보세요.',
        successFeedback: '쌍방 한수쉼으로 계가 모드가 시작되었습니다!',
      },
      {
        id: 'l8-s2',
        stepTitle: '2단계: 죽은 돌(사석) 클릭해 지정하기',
        instruction:
          '왼쪽 흑 집 안에 갇혀 죽은 백돌 1점(**B5 / x=1, y=4**)이 남아있습니다. 반상 위 그 백돌을 직접 클릭해 **사석(죽은 돌)**으로 표시하세요.',
        actionType: 'mark_dead',
        turnColor: BLACK,
        targetDeadCoord: { x: 1, y: 4 },
        initialHighlights: [{ x: 1, y: 4, kind: 'target' }],
        hintCoords: [{ x: 1, y: 4 }],
        hintText: '왼쪽 흑 집 한가운데 있는 백돌(B5)을 클릭하세요.',
        wrongMoveFeedback: '왼쪽 흑 집 안에 고립된 백돌 B5(x=1, y=4)를 클릭해 사석으로 지정해보세요.',
        successFeedback: '사석으로 지정되자 해당 교차점이 흑 집으로 편입되고 점수가 실시간 갱신되었습니다!',
      },
      {
        id: 'l8-s3',
        stepTitle: '3단계: 계가 확정하고 최종 결과 보기',
        instruction:
          '사석 지정이 끝났습니다! 화면 위 계가 배너의 **[계산 확정]** 버튼을 눌러 최종 승패와 집 계산 내역을 확인하세요.',
        actionType: 'confirm_score',
        turnColor: BLACK,
        hintCoords: [],
        hintText: '계가 배너의 [계산 확정] 버튼을 클릭하세요.',
        wrongMoveFeedback: '상단/하단 계가 배너의 [계산 확정] 버튼을 눌러 결과를 확인하세요.',
        successFeedback: '바둑의 시작부터 계가까지 전 과정을 마스터하셨습니다!',
      },
    ],
  },
  {
    id: 'lesson-9-omok-renju',
    number: 9,
    category: '오목 · 렌주',
    title: '오목 4·3 필승 공격과 렌주룰 흑 금수',
    subtitle: '렌주룰에서 흑의 3·3 금수를 피하고, 가장 강력한 4·3(사삼) 외통수 승리를 둡니다.',
    estimatedMinutes: 2,
    gameType: 'omok',
    omokRuleset: 'renju',
    boardSize: 15,
    steps: [
      {
        id: 'l9-s1',
        stepTitle: '3·3 금수를 피하고 4·3(사삼) 외통수 완성하기',
        instruction:
          '렌주룰 흑번에서는 3·3(왼쪽 아래 **C5 / 빨간 ✕**)이 금수입니다! 반면 **4와 열린 3을 동시에 만드는 4·3은 합법이자 필승 수**입니다. 정중앙 천원(**H8 / x=7, y=7**)에 두어 4·3을 완성하세요!',
        actionType: 'move',
        turnColor: BLACK,
        setupStones: [
          // 좌하귀 3·3 금수 예시 (2,10 자리)
          { x: 3, y: 10, color: BLACK },
          { x: 4, y: 10, color: BLACK },
          { x: 2, y: 11, color: BLACK },
          { x: 2, y: 12, color: BLACK },
          // 중앙 4·3 기회 (7,7 자리)
          { x: 7, y: 4, color: BLACK },
          { x: 7, y: 5, color: BLACK },
          { x: 7, y: 6, color: BLACK },
          { x: 8, y: 7, color: BLACK },
          { x: 9, y: 7, color: BLACK },
          // 무관한 백돌들
          { x: 5, y: 5, color: WHITE },
          { x: 5, y: 9, color: WHITE },
          { x: 10, y: 9, color: WHITE },
          { x: 11, y: 11, color: WHITE },
          { x: 3, y: 4, color: WHITE },
        ],
        initialHighlights: [
          { x: 2, y: 10, kind: 'warning' },
          { x: 7, y: 7, kind: 'info' },
        ],
        acceptedMoves: [{ x: 7, y: 7 }],
        hintCoords: [{ x: 7, y: 7 }],
        hintText: '정중앙 천원 화점 H8(x=7, y=7)을 클릭하면 세로 4목과 가로 열린 3목이 동시에 완성됩니다.',
        wrongMoveFeedback: 'C5(x=2, y=10)는 3·3 금수입니다. 중앙 H8(x=7, y=7)에 두어 4·3 필승 형태를 만들어보세요!',
        successFeedback: '완벽한 4·3(사삼) 외통수! 백은 세로 4목을 막더라도 가로 열린 3을 막을 수 없어 흑의 승리가 확정됩니다.',
      },
    ],
  },
];
