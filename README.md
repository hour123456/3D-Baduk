# 수담(手談) — 3D 정통 바둑 게임

> **웹 브라우저 바로 플레이**: https://hour123456.github.io/3D-Baduk/

Three.js 기반 고해상도 절차적 PBR 그래픽과 Web Audio API 물리 모델링 음향 합성, 엄격한 한국식·중국식 바둑 규칙, 그리고 5단계 Web Worker 인공지능(MCTS + RAVE + 전술 판독기)을 갖춘 **3D 정통 바둑 게임(웹 & Windows Electron 데스크톱 앱)** 입니다.

## 주요 특징

- **엄격한 바둑 규칙 엔진 (`src/rules/`)**
  - 한국식 규칙(집 + 사석 계산, 기본 덤 6.5집) 및 중국식 규칙(생존돌 + 집 면적 계산, 기본 덤 7.5집) 완벽 지원
  - 따냄 우선 판정, 자살수 엄격 금지, 64비트 Zobrist 해싱 기반 단패(Simple Ko) 및 동형반복 초패(Positional Superko) 금지
  - `19줄` / `13줄` / `9줄` 바둑판 및 `2~9점` 한국기원 표준 화점 접바둑(백 선수 전환) 지원
  - 연속 한수쉼(Pass) 시 **사석 지정 및 계가 합의 단계** 진입, 제한시간 + 초읽기 시계, 무르기, 수순 복기 및 **SGF 기보 저장/불러오기** 지원
- **사실적인 물리 음향 합성 (`src/audio/`)**
  - 바둑통 커서 이동·클릭 시 오석·해남석 다중 충돌과 대추나무 통 공명이 어우러진 **잘그락거리는 소리**
  - 쌍볼록 바둑돌의 모서리 선접촉 후 본체가 밀착되는 **2단 스냅 착수음('딱! / 착!')** 및 반상 중앙·귀 위치별 공명 변화
  - 인접 돌 옆에 붙여 둘 때의 미세 마찰음('톡/찰칵') 및 사석을 바둑통 뚜껑에 떨어뜨릴 때의 반동 울림음
- **5단계 인공지능 & 2인 로컬 맞대국 (`src/ai/`)**
  - 전용 Web Worker에서 비동기 구동되는 5단계 AI (`입문` / `초급` / `중급` / `고급` / `마스터`)
  - PUCT + RAVE 탐색, 진눈 보호, 단수 및 축(Ladder)·축머리 전술 수읽기, 포석·행마 패턴 탑재

## 실행 방법

```bash
# 의존성 패키지 설치
npm install

# 웹 브라우저 개발 서버 실행 (http://localhost:5173)
npm run dev

# Electron 데스크톱 앱 개발 모드 실행
npm run electron:dev

# 단위 테스트 실행 (규칙 및 AI 검증)
npm run test

# 웹 프로덕션 빌드 (dist/ 생성)
npm run build

# Windows 독립 실행형 데스크톱 앱 패키징 (release/win-unpacked 생성)
npm run electron:pack
```

## GitHub Pages로 웹사이트 열기

이 저장소에는 `.github/workflows/deploy-pages.yml` 자동 배포 워크플로가 포함되어 있습니다.
1. GitHub 저장소 상단의 **Settings** → 좌측 **Pages** 메뉴로 이동합니다.
2. **Build and deployment** 항목의 **Source**를 **GitHub Actions**로 변경하면 자동으로 빌드되어 웹 브라우저에서 바로 플레이 가능한 사이트 주소가 생성됩니다.
