/**
 * scripts/generate-diagrams.mjs
 *
 * LocalSub 시스템 아키텍처 및 파이프라인 SVG 다이어그램을 수학적 좌표 기반으로 생성하는 스크립트.
 * 라이트 모드와 다크 모드(*.dark.svg)를 100% 동기화 생성하며,
 * docs/glossary.md 표준 기술 용어를 반영합니다.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "docs", "diagrams");
mkdirSync(OUT_DIR, { recursive: true });

// ── 테마 정의 ─────────────────────────────────────────────────────────────
const THEMES = {
  light: {
    name: "light",
    bg: "#f8fafc",
    canvasBorder: "#cbd5e1",
    panelBg: "#ffffff",
    panelBorder: "#e2e8f0",
    headerFill: "#f1f5f9",
    textPrimary: "#0f172a",
    textSecondary: "#475569",
    textMuted: "#64748b",
    accentBorder: "#818cf8",
    arrowColor: "#6366f1",
    badgeBg: "#e0e7ff",
    badgeText: "#3730a3",
    blueBg: "#f0f9ff",
    blueBorder: "#bae6fd",
    blueText: "#0369a1",
    greenBg: "#f0fdf4",
    greenBorder: "#bbf7d0",
    greenText: "#15803d",
    amberBg: "#fffbeb",
    amberBorder: "#fde68a",
    amberText: "#b45309",
    purpleBg: "#faf5ff",
    purpleBorder: "#e9d5ff",
    purpleText: "#7e22ce",
  },
  dark: {
    name: "dark",
    bg: "#090d16",
    canvasBorder: "#1e293b",
    panelBg: "#111827",
    panelBorder: "#1f293d",
    headerFill: "#1a2234",
    textPrimary: "#f8fafc",
    textSecondary: "#94a3b8",
    textMuted: "#64748b",
    accentBorder: "#6366f1",
    arrowColor: "#818cf8",
    badgeBg: "#1e1b4b",
    badgeText: "#a5b4fc",
    blueBg: "#082f49",
    blueBorder: "#0369a1",
    blueText: "#7dd3fc",
    greenBg: "#052e16",
    greenBorder: "#15803d",
    greenText: "#86efac",
    amberBg: "#451a03",
    amberBorder: "#b45309",
    amberText: "#fde047",
    purpleBg: "#3b0764",
    purpleBorder: "#7e22ce",
    purpleText: "#d8b4fe",
  },
};

// ── 1. 시스템 아키텍처 다이어그램 생성 ──────────────────────────────────────────
function generateArchitectureSvg(theme) {
  const W = 1240;
  const H = 820;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <style>
      .font-sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      .title { font-weight: 700; font-size: 20px; fill: ${theme.textPrimary}; }
      .subtitle { font-weight: 400; font-size: 13px; fill: ${theme.textMuted}; }
      .section-title { font-weight: 700; font-size: 14px; fill: ${theme.textPrimary}; letter-spacing: 0.5px; }
      .card-title { font-weight: 600; font-size: 13px; fill: ${theme.textPrimary}; }
      .card-body { font-weight: 400; font-size: 12px; fill: ${theme.textSecondary}; }
      .badge-text { font-weight: 600; font-size: 11px; fill: ${theme.badgeText}; }
      .proto-text { font-weight: 600; font-size: 11px; fill: ${theme.blueText}; }
    </style>
    <marker id="arrow-down" markerWidth="8" markerHeight="8" refX="4" refY="7" orient="auto">
      <polygon points="0 0, 8 0, 4 7" fill="${theme.arrowColor}" />
    </marker>
    <marker id="arrow-up" markerWidth="8" markerHeight="8" refX="4" refY="1" orient="auto">
      <polygon points="0 7, 8 7, 4 0" fill="${theme.arrowColor}" />
    </marker>
  </defs>

  <!-- 캔버스 배경 -->
  <rect id="canvas-bg" x="0" y="0" width="${W}" height="${H}" rx="12" fill="${theme.bg}" stroke="${theme.canvasBorder}" stroke-width="1.5" />

  <!-- 문서 헤더 -->
  <g id="header-group">
    <text x="40" y="44" class="font-sans title">LocalSub — 시스템 아키텍처 다이어그램 (System Architecture)</text>
    <text x="40" y="66" class="font-sans subtitle">Tauri 2 데스크톱 코어와 프로세스 격리형 Python 추론 엔진 간의 계층 구조 및 통신 계약</text>
  </g>

  <!-- 계층 1: 호스트 애플리케이션 계층 (Tauri 2 Shell) -->
  <g id="tauri-shell-container">
    <rect id="panel-tauri" x="40" y="90" width="1160" height="254" rx="10" fill="${theme.panelBg}" stroke="${theme.accentBorder}" stroke-width="1.5" />
    <rect id="header-tauri" x="40" y="90" width="1160" height="36" rx="10" fill="${theme.headerFill}" stroke="none" />
    <text x="60" y="113" class="font-sans section-title">TAURI 2 DESKTOP SHELL (HOST RUNTIME)</text>
    <rect id="badge-tauri" x="1050" y="98" width="130" height="20" rx="4" fill="${theme.badgeBg}" />
    <text x="1060" y="112" class="font-sans badge-text">Native Rust Host</text>

    <!-- 1-1. WebKit/WebView 프론트엔드 (React) -->
    <g id="react-frontend-box">
      <rect id="card-react" x="64" y="142" width="520" height="182" rx="8" fill="${theme.blueBg}" stroke="${theme.blueBorder}" stroke-width="1.2" />
      <text x="84" y="168" class="font-sans card-title">React 18 + TypeScript 프론트엔드 (WebView)</text>
      <text x="84" y="192" class="font-sans card-body">• 온보딩 위자드 및 시스템 환경 진단 UI (SetupScreen, Wizard)</text>
      <text x="84" y="214" class="font-sans card-body">• 통합 자막 편집기 (Waveform 파형 내비게이션, 이중 언어 편집)</text>
      <text x="84" y="236" class="font-sans card-body">• 번역 프리셋 및 용어집 관리 인터페이스 (Presets, Vocabulary)</text>
      <text x="84" y="258" class="font-sans card-body">• 작업 큐 상태 머신 및 실시간 SSE 스트림 모니터링</text>
      <text x="84" y="280" class="font-sans card-body">• 런타임 크래시 감지기 및 프론트엔드 자동 복구 가드</text>
      <text x="84" y="302" class="font-sans card-body">• i18next 다국어 지원 및 테마 전환 레이아웃 엔진</text>
    </g>

    <!-- 1-2. Rust 네이티브 백엔드 코어 -->
    <g id="rust-core-box">
      <rect id="card-rust" x="616" y="142" width="560" height="182" rx="8" fill="${theme.greenBg}" stroke="${theme.greenBorder}" stroke-width="1.2" />
      <text x="636" y="168" class="font-sans card-title">Rust 백엔드 코어 (Tauri Commands &amp; Core Modules)</text>
      <text x="636" y="192" class="font-sans card-body">• 자식 프로세스 수명주기 관리 (python_manager: 무창 격리, stderr 캡처)</text>
      <text x="636" y="214" class="font-sans card-body">• 공급망 무결성 검증기 (integrity.rs: SHA-256 해시 고정, requirements.lock)</text>
      <text x="636" y="236" class="font-sans card-body">• 모델 다운로드 엔진 (model_downloader.rs: reqwest, HTTP Range 이어받기)</text>
      <text x="636" y="258" class="font-sans card-body">• 하드웨어 정밀 진단기 (hw_detector.rs: CPU AVX, RAM, nvidia-smi 파싱)</text>
      <text x="636" y="280" class="font-sans card-body">• 자막 I/O 및 인코딩 엔진 (commands_subtitle: SRT, VTT, ASS, TXT 포맷팅)</text>
      <text x="636" y="302" class="font-sans card-body">• 지연 로딩 설정 매니저 (config_manager::ensure_loaded 동시성 레이스 방어)</text>
    </g>
  </g>

  <!-- 계층 간 통신 프로토콜 (IPC & REST/SSE) -->
  <g id="protocol-bridge-group">
    <line x1="584" y1="233" x2="616" y2="233" stroke="${theme.arrowColor}" stroke-width="2" stroke-dasharray="4,4" />

    <line x1="620" y1="344" x2="620" y2="404" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#arrow-down)" marker-start="url(#arrow-up)" />
    <rect id="card-proto" x="420" y="360" width="400" height="28" rx="6" fill="${theme.panelBg}" stroke="${theme.panelBorder}" stroke-width="1.2" />
    <text x="436" y="379" class="font-sans proto-text">HTTP REST API (127.0.0.1:9111) &amp; SSE Event Stream</text>
  </g>

  <!-- 계층 2: 독립 추론 서버 계층 (Python Subprocess) -->
  <g id="python-server-container">
    <rect id="panel-python" x="40" y="410" width="1160" height="220" rx="10" fill="${theme.panelBg}" stroke="${theme.panelBorder}" stroke-width="1.5" />
    <rect id="header-python" x="40" y="410" width="1160" height="36" rx="10" fill="${theme.headerFill}" stroke="none" />
    <text x="60" y="433" class="font-sans section-title">PYTHON INFERENCE SERVER (SUBPROCESS RUNTIME)</text>
    <rect id="badge-python" x="1010" y="418" width="170" height="20" rx="4" fill="${theme.amberBg}" />
    <text x="1022" y="432" class="font-sans" font-size="11" font-weight="600" fill="${theme.amberText}">CREATE_NO_WINDOW</text>

    <!-- 2-1. FastAPI 엔드포인트 라우터 -->
    <g id="router-box">
      <rect id="card-router" x="64" y="462" width="310" height="148" rx="8" fill="${theme.purpleBg}" stroke="${theme.purpleBorder}" stroke-width="1.2" />
      <text x="80" y="488" class="font-sans card-title">FastAPI 서비스 라우터</text>
      <text x="80" y="512" class="font-sans card-body">• /health : 무중단 헬스체크 폴링</text>
      <text x="80" y="534" class="font-sans card-body">• /stt : 음성인식 작업 및 SSE 스트림</text>
      <text x="80" y="556" class="font-sans card-body">• /translate : 신경망 기계번역 라우터</text>
      <text x="80" y="578" class="font-sans card-body">• /runtime : 동적 런타임 제어/언로드</text>
    </g>

    <!-- 2-2. AI 엔진 파이프라인 모듈 -->
    <g id="engines-box">
      <rect id="card-engines" x="394" y="462" width="460" height="148" rx="8" fill="${theme.blueBg}" stroke="${theme.blueBorder}" stroke-width="1.2" />
      <text x="410" y="488" class="font-sans card-title">핵심 추론 엔진 모듈</text>
      <text x="410" y="512" class="font-sans card-body">• stt_engine.py : faster-whisper 래퍼 (Silero VAD, 30분 오디오 청킹)</text>
      <text x="410" y="534" class="font-sans card-body">• llm_engine.py : llama-cpp-python 번역 (세그먼트 단위 순차 추론)</text>
      <text x="410" y="556" class="font-sans card-body">• diarization_engine.py : 화자 분리 (ONNX 임베딩 + scikit-learn 군집화)</text>
      <text x="410" y="578" class="font-sans card-body">• prompt_builder.py : 25/200 롤링 요약 및 용어집 강제 제약조건 주입</text>
    </g>

    <!-- 2-3. 품질 게이트 필터 체계 -->
    <g id="gates-box">
      <rect id="card-gates" x="874" y="462" width="302" height="148" rx="8" fill="${theme.greenBg}" stroke="${theme.greenBorder}" stroke-width="1.2" />
      <text x="890" y="488" class="font-sans card-title">다단계 품질 게이트</text>
      <text x="890" y="512" class="font-sans card-body">• _looks_like_refusal : 구문 거부 직접 탐지</text>
      <text x="890" y="534" class="font-sans card-body">• quality_filters.py : 결정론적 구조 필터</text>
      <text x="890" y="556" class="font-sans card-body">  - 스크립트 누출 및 비정상 반복 검출</text>
      <text x="890" y="578" class="font-sans card-body">• embedding_gate.py : 의미론적 거부 판별</text>
    </g>
  </g>

  <!-- 계층 3: 하드웨어 및 시스템 자원 계층 -->
  <g id="hardware-layer-container">
    <rect id="panel-hardware" x="40" y="650" width="1160" height="126" rx="10" fill="${theme.panelBg}" stroke="${theme.panelBorder}" stroke-width="1.5" />
    <rect id="header-hardware" x="40" y="650" width="1160" height="34" rx="10" fill="${theme.headerFill}" stroke="none" />
    <text x="60" y="673" class="font-sans section-title">SYSTEM HARDWARE &amp; RUNTIME RESOURCE LAYER</text>

    <!-- 하드웨어 구성 요소 3개 카드 -->
    <g id="card-gpu-group">
      <rect id="card-gpu" x="64" y="698" width="360" height="62" rx="6" fill="${theme.bg}" stroke="${theme.panelBorder}" stroke-width="1" />
      <text x="78" y="722" class="font-sans card-title">NVIDIA CUDA GPU 가속 환경</text>
      <text x="78" y="744" class="font-sans card-body">Whisper ↔ Qwen3 LLM VRAM 분할 점유 핸드오버</text>
    </g>

    <g id="card-cpu-group">
      <rect id="card-cpu" x="444" y="698" width="360" height="62" rx="6" fill="${theme.bg}" stroke="${theme.panelBorder}" stroke-width="1" />
      <text x="458" y="722" class="font-sans card-title">호스트 CPU (AVX2 지원 멀티스레딩)</text>
      <text x="458" y="744" class="font-sans card-body">CPU 전용 폴백 모드 (int8 STT, Q4_K_M GGUF 번역)</text>
    </g>

    <g id="card-fs-group">
      <rect id="card-fs" x="824" y="698" width="352" height="62" rx="6" fill="${theme.bg}" stroke="${theme.panelBorder}" stroke-width="1" />
      <text x="838" y="722" class="font-sans card-title">로컬 파일 시스템</text>
      <text x="838" y="744" class="font-sans card-body">%APPDATA%/LocalSub (설정, 모델, 로그 격리)</text>
    </g>
  </g>
</svg>`;
}

// ── 2. 자막 처리 파이프라인 다이어그램 생성 ─────────────────────────────────────
function generatePipelineSvg(theme) {
  const W = 1240;
  const H = 720;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <style>
      .font-sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      .title { font-weight: 700; font-size: 20px; fill: ${theme.textPrimary}; }
      .subtitle { font-weight: 400; font-size: 13px; fill: ${theme.textMuted}; }
      .step-num { font-weight: 700; font-size: 11px; fill: ${theme.badgeText}; }
      .step-title { font-weight: 700; font-size: 13px; fill: ${theme.textPrimary}; }
      .step-desc { font-weight: 400; font-size: 11px; fill: ${theme.textSecondary}; }
      .conn-label { font-weight: 600; font-size: 10px; fill: ${theme.textMuted}; }
    </style>
    <marker id="pipe-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <polygon points="0 0, 8 4, 0 8" fill="${theme.arrowColor}" />
    </marker>
    <marker id="pipe-arrow-down" markerWidth="8" markerHeight="8" refX="4" refY="7" orient="auto">
      <polygon points="0 0, 8 0, 4 7" fill="${theme.arrowColor}" />
    </marker>
  </defs>

  <!-- 캔버스 배경 -->
  <rect id="canvas-bg" x="0" y="0" width="${W}" height="${H}" rx="12" fill="${theme.bg}" stroke="${theme.canvasBorder}" stroke-width="1.5" />

  <!-- 문서 헤더 -->
  <g id="header-group">
    <text x="40" y="44" class="font-sans title">LocalSub — 자막 생성 및 신경망 기계번역 파이프라인 (Processing Pipeline)</text>
    <text x="40" y="66" class="font-sans subtitle">오디오 입력부터 STT, VRAM 재할당 핸드오버, LLM 번역, 품질 게이트, 자막 출력까지의 엔드투엔드 데이터 흐름</text>
  </g>

  <!-- 상단 단계 1 ~ 3: 미디어 입력, STT 및 VAD, VRAM 핸드오버 -->
  <g id="stage-1-input">
    <rect id="box-stage-1" x="40" y="100" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.blueBorder}" stroke-width="1.5" />
    <rect id="badge-stage-1" x="56" y="116" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="64" y="131" class="font-sans step-num">단계 01</text>
    <text x="124" y="132" class="font-sans step-title">미디어 입력 및 오디오 처리</text>
    <text x="56" y="164" class="font-sans step-desc">• 미디어 파일 수신 (MP4, MKV, AVI, WAV 등)</text>
    <text x="56" y="188" class="font-sans step-desc">• 미디어 재생 시간 분석 (ffprobe 기반 정밀 측정)</text>
    <text x="56" y="212" class="font-sans step-desc">• 60분 초과 시 30분 오디오 청킹 (FFmpeg 분할)</text>
    <text x="56" y="236" class="font-sans step-desc">• 60분 미만 시 PyAV 직접 디코딩 처리</text>
    <text x="56" y="260" class="font-sans step-desc">• 16kHz 모노 오디오 버퍼 변환 생성</text>
    <text x="56" y="284" class="font-sans step-desc">• 체크포인트 파일 초기화 (장애 복원 대비)</text>
    <text x="56" y="308" class="font-sans step-desc">• Rust 작업 큐 등록 (JobStatus::Starting)</text>
  </g>

  <!-- 1 -> 2 화살표 -->
  <line x1="400" y1="225" x2="438" y2="225" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#pipe-arrow)" />

  <g id="stage-2-stt">
    <rect id="box-stage-2" x="440" y="100" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.greenBorder}" stroke-width="1.5" />
    <rect id="badge-stage-2" x="456" y="116" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="464" y="131" class="font-sans step-num">단계 02</text>
    <text x="524" y="132" class="font-sans step-title">음성 인식 및 화자 분리</text>
    <text x="456" y="164" class="font-sans step-desc">• faster-whisper (CTranslate2) 추론 가속</text>
    <text x="456" y="188" class="font-sans step-desc">• Silero VAD 적용 (비발화 구간 필터링)</text>
    <text x="456" y="212" class="font-sans step-desc">• 7개 언어 자동 감지 (초기 30초 오디오 분석)</text>
    <text x="456" y="236" class="font-sans step-desc">• 타임스탬프 세그먼트 생성 (Start, End)</text>
    <text x="456" y="260" class="font-sans step-desc">• ONNX Runtime 음향 임베딩 추출</text>
    <text x="456" y="284" class="font-sans step-desc">• scikit-learn 응집 군집화 기반 화자 분리</text>
    <text x="456" y="308" class="font-sans step-desc">• SSE 스트림 실시간 방출 (stt-segment 이벤트)</text>
  </g>

  <!-- 2 -> 3 화살표 -->
  <line x1="800" y1="225" x2="838" y2="225" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#pipe-arrow)" />

  <g id="stage-3-vram">
    <rect id="box-stage-3" x="840" y="100" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.amberBorder}" stroke-width="1.5" />
    <rect id="badge-stage-3" x="856" y="116" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="864" y="131" class="font-sans step-num">단계 03</text>
    <text x="924" y="132" class="font-sans step-title">VRAM 재할당 핸드오버</text>
    <text x="856" y="164" class="font-sans step-desc">• Whisper 런타임 세그폴트 방지 정책 적용</text>
    <text x="856" y="188" class="font-sans step-desc">• Python 추론 서버 정상 재기동 (restart_server)</text>
    <text x="856" y="212" class="font-sans step-desc">• Whisper 점유 VRAM 100% 완전 회수</text>
    <text x="856" y="236" class="font-sans step-desc">• nvidia-smi 가용 VRAM &gt; 6GB 대기 (최대 20초)</text>
    <text x="856" y="260" class="font-sans step-desc">• /health 헬스체크 정상 수신 대기</text>
    <text x="856" y="284" class="font-sans step-desc">• 실패 시 mark_server_failed 상태 안전 복구</text>
    <text x="856" y="308" class="font-sans step-desc">• llama-cpp-python 번역 엔진 VRAM 확보 완료</text>
  </g>

  <!-- 3단계에서 아래 4단계로 전이하는 연결선 -->
  <path d="M 1020 350 L 1020 395 L 220 395 L 220 428" fill="none" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#pipe-arrow-down)" />
  <rect id="card-pipe-conn" x="520" y="382" width="200" height="24" rx="4" fill="${theme.panelBg}" stroke="${theme.panelBorder}" stroke-width="1" />
  <text x="535" y="398" class="font-sans conn-label">세그먼트 전달 및 NMT 단계 진입</text>

  <!-- 하단 단계 4 ~ 6: LLM 번역, 품질 게이트, 자막 출력 -->
  <g id="stage-4-translate">
    <rect id="box-stage-4" x="40" y="430" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.purpleBorder}" stroke-width="1.5" />
    <rect id="badge-stage-4" x="56" y="446" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="64" y="461" class="font-sans step-num">단계 04</text>
    <text x="124" y="462" class="font-sans step-title">신경망 기계번역 (LLM)</text>
    <text x="56" y="494" class="font-sans step-desc">• llama-cpp-python GGUF 양자화 모델 적재</text>
    <text x="56" y="518" class="font-sans step-desc">• 세그먼트 단위 순차 번역 (배치 미사용)</text>
    <text x="56" y="542" class="font-sans step-desc">• 컨텍스트 윈도우 주입 (±N 라인 문맥)</text>
    <text x="56" y="566" class="font-sans step-desc">• 25개 세그먼트마다 롤링 요약 갱신</text>
    <text x="56" y="590" class="font-sans step-desc">• 200개 세그먼트마다 요약 재생성 (Drift 방지)</text>
    <text x="56" y="614" class="font-sans step-desc">• 용어집(Vocabulary) 강제 제약조건 주입</text>
    <text x="56" y="638" class="font-sans step-desc">• 스타일 프리셋 적용 (자연스러운/격식체/직역)</text>
  </g>

  <!-- 4 -> 5 화살표 -->
  <line x1="400" y1="555" x2="438" y2="555" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#pipe-arrow)" />

  <g id="stage-5-gate">
    <rect id="box-stage-5" x="440" y="430" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.greenBorder}" stroke-width="1.5" />
    <rect id="badge-stage-5" x="456" y="446" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="464" y="461" class="font-sans step-num">단계 05</text>
    <text x="524" y="462" class="font-sans step-title">다단계 품질 게이트 평가</text>
    <text x="456" y="494" class="font-sans step-desc">• 1차: 구문 거부 직접 탐지 (_looks_like_refusal)</text>
    <text x="456" y="518" class="font-sans step-desc">• 2차: 구조적 필터링 (quality_filters.py)</text>
    <text x="456" y="542" class="font-sans step-desc">  - 스크립트 누출 탐지 (한글/영문/한자 불일치)</text>
    <text x="456" y="566" class="font-sans step-desc">  - 텍스트 길이 폭증 및 퇴행적 반복 감지</text>
    <text x="456" y="590" class="font-sans step-desc">• 3차: 의미론적 임베딩 게이트 (embedding_gate.py)</text>
    <text x="456" y="614" class="font-sans step-desc">• 불량 판정 시: 고온도(High Temp) 1회 재시도</text>
    <text x="456" y="638" class="font-sans step-desc">• 재시도 실패 시 이상 플래그 부여 및 보존</text>
  </g>

  <!-- 5 -> 6 화살표 -->
  <line x1="800" y1="555" x2="838" y2="555" stroke="${theme.arrowColor}" stroke-width="2" marker-end="url(#pipe-arrow)" />

  <g id="stage-6-export">
    <rect id="box-stage-6" x="840" y="430" width="360" height="250" rx="10" fill="${theme.panelBg}" stroke="${theme.blueBorder}" stroke-width="1.5" />
    <rect id="badge-stage-6" x="856" y="446" width="58" height="22" rx="4" fill="${theme.badgeBg}" />
    <text x="864" y="461" class="font-sans step-num">단계 06</text>
    <text x="924" y="462" class="font-sans step-title">자막 편집 및 다중 포맷 출력</text>
    <text x="856" y="494" class="font-sans step-desc">• 에디터 내 플래그 세그먼트 시각적 하이라이트</text>
    <text x="856" y="518" class="font-sans step-desc">• 개별 라인 재번역 및 일괄 재번역 지원</text>
    <text x="856" y="542" class="font-sans step-desc">• 타임코드 시프트 및 세그먼트 분할/병합</text>
    <text x="856" y="566" class="font-sans step-desc">• 표준 SRT (SubRip) 규격 파일 출력</text>
    <text x="856" y="590" class="font-sans step-desc">• WebVTT (HTML5 웹 비디오) 규격 파일 출력</text>
    <text x="856" y="614" class="font-sans step-desc">• ASS (Advanced SubStation Alpha) 스타일 출력</text>
    <text x="856" y="638" class="font-sans step-desc">• 원문 + 번역문 통합 이중 언어 자막 완벽 지원</text>
  </g>
</svg>`;
}

// ── 빌드 실행 ─────────────────────────────────────────────────────────────
console.log("Generating SVG diagrams...");

const archLight = generateArchitectureSvg(THEMES.light);
const archDark = generateArchitectureSvg(THEMES.dark);
writeFileSync(join(OUT_DIR, "architecture.svg"), archLight, "utf-8");
writeFileSync(join(OUT_DIR, "architecture.dark.svg"), archDark, "utf-8");
console.log("✓ Generated docs/diagrams/architecture.svg & architecture.dark.svg");

const pipeLight = generatePipelineSvg(THEMES.light);
const pipeDark = generatePipelineSvg(THEMES.dark);
writeFileSync(join(OUT_DIR, "pipeline.svg"), pipeLight, "utf-8");
writeFileSync(join(OUT_DIR, "pipeline.dark.svg"), pipeDark, "utf-8");
console.log("✓ Generated docs/diagrams/pipeline.svg & pipeline.dark.svg");

console.log("All diagrams successfully generated in docs/diagrams/");
