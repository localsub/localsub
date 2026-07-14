# LocalSub — 요구사항 명세서 v2.0

> **변경 이력**
> | 버전 | 날짜 | 내용 |
> |------|------|------|
> | v1.0 | — | 초기 명세 |
> | v1.1 | — | PyInstaller exe화 전략 추가 |
> | v1.2 | 2026-02-27 | 실제 구현(내장 Python + 런타임 pip) 반영, NSIS 전환, 완비/미완 분류 추가 |
> | v2.0 | 2026-02-27 | Phase 1 전면 개정: 기능 명세(FR/NFR) + 완료 조건 + 기술 결정사항 + 데이터 구조 + 8-Sprint 체크리스트 |
> | v2.1 | 2026-02-28 | config.json에 active_whisper_model / active_llm_model 필드 추가 |
> | v2.2 | 2026-06-15 | 공급망 강화(`requirements.lock` `--require-hashes`, `integrity.json` sha256 검증+미러 폴백, llama 휠/ffmpeg 직접 다운로드 검증), 레거시 파일-glossary 제거(`active_glossary`/`save_glossary`), 첫 실행 E2E 스크립트 + CI 반영 |

---

## 1. 프로젝트 개요

음성/영상 파일에서 자막(STT)을 추출하고, 로컬 LLM(Qwen3)으로 번역하는 데스크톱 앱.
Tauri(Rust) 셸과 FastAPI(Python) 백엔드를 **프로세스 분리** 방식으로 결합하며,
SSE(Server-Sent Events)를 통해 추론 진행 상황을 실시간 스트리밍한다.
Phase 1은 **Local First** 전략으로 오프라인 동작을 보장하고, 외부 API는 선택적 부가 기능으로 제공한다.

| 항목 | 값 |
|------|----|
| 제품명 | LocalSub |
| 식별자 | `LocalSub` |
| 버전 | 0.1.0 (Phase 1) |
| 프론트엔드 | React 18 + TypeScript + Vite |
| 백엔드 | FastAPI + Uvicorn + sse-starlette |
| STT 엔진 | faster-whisper (CTranslate2) |
| LLM 엔진 | llama-cpp-python (GGUF) |
| 데스크톱 프레임워크 | Tauri 2 |
| 대상 OS | Windows (현재), macOS/Linux (향후 확장 가능) |

### 기술 결정사항

| 항목 | 결정 | 근거 |
|------|------|------|
| Whisper 백엔드 | **faster-whisper** | CTranslate2 기반, CPU/GPU 모두 지원, HF 모델 직접 사용, 메모리 효율적 |
| LLM 백엔드 | **llama-cpp-python** | Windows CUDA 지원, GGUF 포맷, 모든 프로파일(Lite/Balanced/Power) 통일 |
| 모델 다운로드 | **Rust 직접** (reqwest) | Python 서버 불필요, 위자드 단계에서 서버 없이 동작, Range 헤더로 resume 지원 |
| 설치 포맷 | NSIS (.exe) 유지 | 변경 없음 |
| vLLM | Phase 1 제외 | Windows 미지원, 향후 Linux/WSL 확장 시 도입 |

---

## 2. 아키텍처

```
┌──────────────────────────────────────────────────────┐
│  Tauri Shell (Rust)                                  │
│  ┌─────────────────┐  ┌──────────────────────────┐   │
│  │  React Frontend │  │  Rust Commands (IPC)     │   │
│  │  (WebView)      │◄─┤  - 위자드/온보딩          │   │
│  │  - 위자드 UI     │  │  - 모델 다운로드 (reqwest)│   │
│  │  - 번역 워크플로  │  │  - HW 진단              │   │
│  │  - 설정 패널     │  │  - 설정 관리             │   │
│  └─────────────────┘  └───────────┬──────────────┘   │
│                                   │                  │
│            HTTP / SSE (127.0.0.1:9111)               │
│                                   │                  │
│  ┌────────────────────────────────▼──────────────┐   │
│  │  Python Server (FastAPI)                      │   │
│  │  - 내장 Python 3.12 embeddable                │   │
│  │  - faster-whisper (STT)                       │   │
│  │  - llama-cpp-python (LLM 번역)                │   │
│  │  - 런타임 pip install 패키지 관리               │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 통신 방식

| 구간 | 프로토콜 | 설명 |
|------|----------|------|
| Frontend ↔ Rust | Tauri IPC (`invoke`) | 커맨드 호출 + 이벤트 리스닝 |
| Rust → Python | HTTP POST/GET | STT/번역 시작, 취소, 헬스체크, 모델 로드 |
| Python → Rust | SSE (GET stream) | 진행률, 완료, 에러 스트리밍 |
| Rust → HuggingFace | HTTPS (reqwest) | 모델 파일 다운로드 (위자드 단계, 서버 불필요) |

---

## 3. 기능 요구사항 (Functional Requirements)

### FR-W: 위자드 / 온보딩

#### W-01: 위자드 진입 조건

| ID | 요구사항 | 설명 |
|----|----------|------|
| W-01.1 | 첫 실행 감지 | `%APPDATA%/LocalSub/config.json` 부재 시 위자드 시작 |
| W-01.2 | 위자드 상태 유지 | 각 단계 완료 여부를 config.json에 기록, 중단 후 재개 가능 |
| W-01.3 | 스킵 옵션 | 이전 사용자: 위자드 전체 스킵 버튼 (기본값으로 설정) |

**완료 조건**: 앱 최초 실행 시 위자드가 자동 표시되며, 완료 후 재실행 시 메인 화면으로 직행한다. 중간에 앱을 종료하고 재시작하면 마지막 완료 단계 다음부터 재개한다.

#### W-02: 환경 진단

| ID | 요구사항 | 설명 |
|----|----------|------|
| W-02.1 | CPU 정보 수집 | 코어 수, AVX/AVX2 지원 여부 |
| W-02.2 | 메모리 정보 | 총 RAM, 가용 RAM |
| W-02.3 | 디스크 정보 | 선택 경로의 가용 디스크 공간 |
| W-02.4 | GPU 감지 | NVIDIA GPU 이름, VRAM, CUDA 버전 (nvidia-smi 파싱) |
| W-02.5 | 프로파일 추천 | HW 정보 기반 Lite/Balanced/Power 자동 추천 |

**완료 조건**: 위자드 환경 진단 단계에서 CPU(코어/AVX), RAM, 디스크, GPU(있으면) 정보가 카드 형태로 표시되고, 그에 맞는 프로파일이 자동 선택된다. GPU 없는 PC에서는 "CPU Only" 표시와 함께 Lite가 기본 선택된다.

#### W-03: 출력 설정

| ID | 요구사항 | 설명 |
|----|----------|------|
| W-03.1 | 출력 폴더 선택 | Tauri dialog로 폴더 선택, 기본값: 사용자 Documents |
| W-03.2 | 자막 포맷 | SRT (기본) / VTT / ASS 선택 |
| W-03.3 | 언어 설정 | 소스 언어 (auto-detect 기본), 타겟 언어 (한국어 기본) |

**완료 조건**: 출력 폴더가 실제 쓰기 가능한 경로인지 검증 후 config.json에 저장된다. 자막 포맷과 언어 설정이 드롭다운으로 선택 가능하다.

#### W-04: 컴포넌트 설치 선택

| ID | 요구사항 | 설명 |
|----|----------|------|
| W-04.1 | Whisper 모델 선택 | tiny/base/small/medium/large-v3 (프로파일 기반 기본값) |
| W-04.2 | Qwen3 LLM 선택 | 프로파일별 권장 GGUF 퀀트 (Q4_K_M/Q5_K_M/Q8_0) |
| W-04.3 | 설치 크기 표시 | 각 컴포넌트 다운로드 크기 + 총 필요 디스크 공간 |
| W-04.4 | 번역 비활성 | Qwen3 스킵 가능 (STT만 사용, 번역 OFF) |

**완료 조건**: 프로파일에 따라 기본 모델이 자동 선택되고, 사용자가 변경 가능하다. "총 다운로드 크기: X.X GB" 표시가 정확하다. Qwen3를 스킵하면 번역 모드가 OFF로 설정된다.

#### W-05: 모델 다운로드 + 설치

| ID | 요구사항 | 설명 |
|----|----------|------|
| W-05.1 | 다운로드 실행 | Rust에서 reqwest로 HuggingFace에서 직접 다운로드 |
| W-05.2 | 진행률 표시 | 파일별 + 전체 진행률 바, 속도(MB/s), ETA |
| W-05.3 | 이어받기 | Range 헤더로 중단된 다운로드 재개 |
| W-05.4 | 해시 검증 | 다운로드 완료 후 SHA-256 검증 |
| W-05.5 | pip 셋업 통합 | 모델 다운로드 후 Python 패키지 셋업 자동 실행 |

**완료 조건**: 네트워크 중단 후 재시작 시 이어받기가 동작한다. 해시 불일치 시 해당 파일만 재다운로드한다. 전체 다운로드 + pip 셋업 완료 후 "설치 완료" 화면이 표시된다.

---

### FR-M: 모델 관리

#### M-01: 모델 카탈로그

| ID | 요구사항 | 설명 |
|----|----------|------|
| M-01.1 | 내장 카탈로그 | `model_catalog.json`을 Rust 번들에 포함, 사용 가능한 모델 목록 정의 |
| M-01.2 | 카탈로그 구조 | 모델별: id, type(whisper/llm), repo, filename, size, sha256, quant, profile |
| M-01.3 | 버전 관리 | 카탈로그 버전 필드, 향후 온라인 업데이트 대비 |

**완료 조건**: `model_catalog.json`이 Whisper 모델 5종 + Qwen3 GGUF 3종 이상의 엔트리를 포함하며, 각 엔트리에 다운로드 URL, 파일 크기, SHA-256 해시가 있다.

#### M-02: 모델 저장소 관리

| ID | 요구사항 | 설명 |
|----|----------|------|
| M-02.1 | 저장 경로 | 기본: `%APPDATA%/LocalSub/models/` |
| M-02.2 | 커스텀 경로 | 위자드에서 변경 가능, config.json에 저장 |
| M-02.3 | manifest.json | 설치된 모델 목록 + 상태 + 경로를 `models/manifest.json`에 기록 |
| M-02.4 | 무결성 검증 | 앱 시작 시 manifest의 모델 파일 존재 + 해시 검증 |

**완료 조건**: 모델 다운로드 후 manifest.json에 해당 모델이 `"status": "ready"` 로 기록된다. 모델 파일을 수동 삭제하면 다음 앱 시작 시 manifest가 `"status": "missing"`으로 업데이트되고 재다운로드를 안내한다.

#### M-03: 모델 삭제

| ID | 요구사항 | 설명 |
|----|----------|------|
| M-03.1 | 개별 삭제 | 설정 화면에서 모델별 삭제 버튼 |
| M-03.2 | 확인 다이얼로그 | 삭제 전 확인 팝업 (모델 이름 + 크기 표시) |
| M-03.3 | manifest 동기화 | 삭제 후 manifest.json에서 해당 엔트리 제거 |

**완료 조건**: 삭제 클릭 → 확인 → 파일 삭제 + manifest 업데이트가 3초 이내 완료된다. 현재 로드된 모델은 먼저 언로드 후 삭제 가능하다.

#### M-04: 프로파일 시스템

| ID | 요구사항 | 설명 |
|----|----------|------|
| M-04.1 | 프로파일 정의 | Lite / Balanced / Power 3단계 |
| M-04.2 | 자동 추천 | HW 진단 결과 기반 자동 프로파일 선택 |
| M-04.3 | 수동 변경 | 설정에서 프로파일 변경 가능 (관련 모델 재다운로드 안내) |

**완료 조건**: 프로파일 변경 시 현재 설치된 모델과 새 프로파일 권장 모델이 다르면 "모델 변경 필요" 알림이 표시된다.

**프로파일 룰**:

| 프로파일 | RAM | GPU VRAM | Whisper 모델 | Qwen3 GGUF | n_gpu_layers |
|----------|-----|----------|-------------|------------|--------------|
| Lite | < 16GB | 없음 또는 < 4GB | tiny / base | Q4_K_M (4B) | 0 (CPU only) |
| Balanced | ≥ 16GB | 4–8GB | small / medium | Q5_K_M (8B) | 20–35 |
| Power | ≥ 32GB | ≥ 8GB | large-v3 | Q8_0 (14B) | -1 (전체 GPU) |

---

### FR-S: STT 파이프라인

#### S-01: 음성 인식 (Whisper)

| ID | 요구사항 | 설명 |
|----|----------|------|
| S-01.1 | 파일 입력 | 오디오/비디오 파일 선택 (mp3, wav, mp4, mkv, etc.) |
| S-01.2 | faster-whisper 실행 | Python 서버에서 faster-whisper 모델 로드 + transcribe |
| S-01.3 | 세그먼트 스트리밍 | SSE로 세그먼트 단위 실시간 전송 (타임스탬프 + 텍스트) |
| S-01.4 | 언어 감지 | auto-detect 모드 시 첫 30초에서 언어 감지 후 결과 전송 |
| S-01.5 | 모델 로드 상태 | 모델 로딩 중 "Loading model..." 표시, 로드 완료 후 처리 시작 |

**완료 조건**: 5분 오디오 파일을 입력하면 세그먼트가 실시간으로 화면에 나타나고, 완료 시 전체 SRT가 생성된다. 진행률이 0–100%로 표시된다.

#### S-02: 자막 출력

| ID | 요구사항 | 설명 |
|----|----------|------|
| S-02.1 | SRT 생성 | 표준 SRT 포맷 (인덱스, 타임스탬프, 텍스트) |
| S-02.2 | VTT 생성 | WebVTT 포맷 |
| S-02.3 | ASS 생성 | Advanced SubStation Alpha 포맷 |
| S-02.4 | 파일 저장 | 출력 폴더에 `{원본파일명}.{포맷}` 으로 저장 |
| S-02.5 | 미리보기 | 완료 전이라도 현재까지 생성된 세그먼트 미리보기 |

**완료 조건**: STT 완료 후 설정된 포맷의 자막 파일이 출력 폴더에 생성된다. SRT 파일을 외부 플레이어에서 로드하면 타임스탬프가 정확하게 동기화된다.

#### S-03: STT 취소

| ID | 요구사항 | 설명 |
|----|----------|------|
| S-03.1 | 취소 요청 | 진행 중 취소 버튼 클릭 |
| S-03.2 | 부분 결과 보존 | 취소 시점까지의 세그먼트 보존 (저장 옵션 제공) |

**완료 조건**: 취소 후 3초 이내 STT 프로세스가 중단되며, "부분 결과 저장" 옵션이 표시된다.

---

### FR-T: 번역 파이프라인

#### T-01: 번역 모드

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-01.1 | OFF | 번역 없이 원본 자막만 출력 |
| T-01.2 | Local Qwen3 | llama-cpp-python으로 로컬 LLM 번역 |
| T-01.3 | External API | 외부 API (OpenAI/Anthropic/etc) 번역 |

**완료 조건**: 번역 모드 전환이 설정 화면 드롭다운으로 가능하며, 모드 전환 즉시 다음 번역 작업부터 적용된다.

#### T-02: 컨텍스트 윈도우 번역

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-02.1 | 윈도우 크기 | ±N 라인 (N=0, 2, 5), 설정에서 변경 가능 |
| T-02.2 | 프롬프트 구성 | 이전 N줄 + 현재 줄 + 다음 N줄을 LLM 프롬프트에 포함 |
| T-02.3 | 번역 대상 표시 | 프롬프트에서 번역할 줄을 `>>>` 마커로 표시 |

**완료 조건**: N=2일 때 3번째 자막 번역 시 1–5번째 자막이 컨텍스트로 포함된다. 첫/마지막 줄에서도 에러 없이 동작한다 (가용한 만큼만 포함).

#### T-03: 용어집 (Glossary)

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-03.1 | 용어집 등록 | key-value 쌍 (원문 → 번역) |
| T-03.2 | 프롬프트 주입 | 해당 세그먼트에 용어가 포함되면 프롬프트에 glossary hint 추가 |
| T-03.3 | 파일 관리 | JSON 파일로 저장/로드/편집 |

**완료 조건**: 용어집에 "Transformer → 트랜스포머"를 등록 후 "Transformer architecture"를 번역하면 "트랜스포머"가 사용된다. 용어집은 `%APPDATA%/.../glossaries/` 에 JSON으로 저장된다.

#### T-04: 스타일 프리셋

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-04.1 | 자연스러운 | 구어체, 의역 허용 |
| T-04.2 | 격식체 | 존댓말, 공식 표현 |
| T-04.3 | 직역 | 원문 구조 최대 보존 |
| T-04.4 | 비속어 보존 | 원문 비속어를 대응 표현으로 번역 (검열 안 함) |

**완료 조건**: 스타일 프리셋 변경이 다음 번역부터 즉시 반영된다. 각 프리셋은 시스템 프롬프트에 반영되며, 번역 결과에 스타일 차이가 관찰된다.

#### T-05: 번역 실행

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-05.1 | 세그먼트별 번역 | STT 세그먼트를 하나씩 순차 번역 |
| T-05.2 | SSE 스트리밍 | 번역 중간 결과 토큰 단위 스트리밍 |
| T-05.3 | 이중 자막 출력 | 원본 + 번역을 나란히 표시 / 이중 자막 파일 생성 |
| T-05.4 | 진행률 | 전체 세그먼트 대비 완료 세그먼트 비율 |

**완료 조건**: 100개 세그먼트 자막의 번역 진행률이 1%씩 증가하며, 완료 시 이중 자막 SRT가 생성된다. 각 세그먼트 번역 중 토큰이 실시간으로 표시된다.

#### T-06: 번역 취소

| ID | 요구사항 | 설명 |
|----|----------|------|
| T-06.1 | 취소 요청 | 진행 중 취소 버튼 |
| T-06.2 | 부분 결과 | 번역 완료된 세그먼트까지의 결과 보존 |

**완료 조건**: 취소 후 번역된 세그먼트까지의 이중 자막 파일 저장 옵션이 제공된다.

---

### FR-R: 런타임 관리

#### R-01: LLM 런타임

| ID | 요구사항 | 설명 |
|----|----------|------|
| R-01.1 | 모델 로드 | llama-cpp-python으로 GGUF 모델 로드 (n_gpu_layers 프로파일 기반) |
| R-01.2 | 모델 언로드 | 메모리 해제를 위한 명시적 언로드 |
| R-01.3 | 상태 표시 | UNLOADED / LOADING / READY / ERROR |
| R-01.4 | VRAM 부족 감지 | 로드 실패 시 n_gpu_layers를 줄여서 재시도 → 최종 CPU fallback |

**완료 조건**: 모델 로드 시 "Loading Qwen3..." 표시 → 완료 후 "Ready (GPU: 30 layers)" 표시. VRAM 부족 시 자동으로 layer 수를 절반으로 줄여 재시도하고, 최종 실패 시 CPU 모드로 전환한다.

#### R-02: Whisper 런타임

| ID | 요구사항 | 설명 |
|----|----------|------|
| R-02.1 | 모델 로드 | faster-whisper 모델 초기화 (compute_type 프로파일 기반) |
| R-02.2 | compute_type | CPU: int8, GPU: float16 |
| R-02.3 | 상태 표시 | UNLOADED / LOADING / READY / ERROR |

**완료 조건**: Whisper 모델 로드 후 `GET /runtime/status`에서 whisper 상태가 "ready"로 응답한다.

#### R-03: 리소스 모니터

| ID | 요구사항 | 설명 |
|----|----------|------|
| R-03.1 | RAM 사용량 | Python 프로세스 RSS 표시 |
| R-03.2 | GPU VRAM 사용량 | nvidia-smi 파싱 또는 pynvml (있으면) |
| R-03.3 | 위험 경고 | RAM > 90% 또는 VRAM > 95% 시 경고 표시 |

**완료 조건**: 메인 화면 하단에 RAM/VRAM 사용량 바가 표시되며, 임계치 초과 시 주황/빨강 색상으로 변경된다.

---

### FR-E: 외부 API (선택적)

#### E-01: API 설정

| ID | 요구사항 | 설명 |
|----|----------|------|
| E-01.1 | 프로바이더 선택 | OpenAI / Anthropic / Custom |
| E-01.2 | API 키 입력 | 암호화 저장 (Tauri secure store 또는 OS keychain) |
| E-01.3 | 연결 테스트 | "Test Connection" 버튼으로 키 유효성 검증 |

**완료 조건**: API 키 입력 후 "Test Connection" 클릭 시 성공/실패가 3초 이내 표시된다. 키는 평문으로 config.json에 저장되지 않는다.

#### E-02: API 폴백

| ID | 요구사항 | 설명 |
|----|----------|------|
| E-02.1 | 수동 전환 | 번역 모드를 "External API"로 변경 |
| E-02.2 | 자동 폴백 | 로컬 LLM 에러 시 "외부 API로 전환하시겠습니까?" 다이얼로그 |

**완료 조건**: 로컬 LLM 에러 → 다이얼로그 → "예" 클릭 → 해당 작업이 외부 API로 이어서 번역된다.

---

### FR-1~7: 기존 구현 (DONE)

> 아래 기능은 v1.2에서 구현 완료된 기반 기능이다.

#### FR-1: Python 서버 제어 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-1.1 | 서버 시작 | `start_server` 커맨드로 Python 프로세스 시작 | DONE |
| FR-1.2 | 서버 중지 | `stop_server` 커맨드로 프로세스 종료 (`kill`) | DONE |
| FR-1.3 | 상태 표시 | STOPPED / STARTING / RUNNING / ERROR 4단계 | DONE |
| FR-1.4 | 중복 방지 | RUNNING 또는 STARTING 상태에서 재시작 차단 | DONE |
| FR-1.5 | 헬스체크 | `GET /health` 60회 × 500ms 폴링 (최대 30초) | DONE |
| FR-1.6 | 앱 종료 정리 | 앱 종료 시 Python 프로세스 `kill()` + `wait()` | DONE |

**완료 조건** ✅: `start_server` → 30초 내 RUNNING 전환, `stop_server` → STOPPED 전환, 앱 종료 시 orphan 프로세스 없음. RUNNING 상태 재시작 시 에러 반환.

#### FR-2: 추론 시작 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-2.1 | 입력 | 텍스트 입력 (TextArea, 3줄) | DONE |
| FR-2.2 | 작업 생성 | `POST /inference/start` → `job_id` (UUID4) 반환 | DONE |
| FR-2.3 | 상태 게이트 | 서버 RUNNING 상태에서만 추론 가능 | DONE |

**완료 조건** ✅: 텍스트 입력 → `start_inference` → job_id 반환 + SSE 자동 구독 시작. 서버 STOPPED 시 추론 불가.

#### FR-3: 진행률 스트리밍 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-3.1 | SSE 구독 | `GET /inference/stream/{job_id}` 자동 구독 | DONE |
| FR-3.2 | 진행률 표시 | ProgressBar (0–100%) + 메시지 텍스트 | DONE |
| FR-3.3 | 이벤트 타입 | `progress`, `done`, `error`, `cancelled` | DONE |

**완료 조건** ✅: SSE 구독으로 progress(0–100%) → done/error/cancelled 이벤트가 순서대로 수신되며, ProgressBar에 실시간 반영.

#### FR-4: 작업 완료 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-4.1 | 결과 표시 | 완료 시 result 텍스트 표시 | DONE |
| FR-4.2 | 결과 복사 | "Copy Result" 버튼 → 클립보드 | DONE |

**완료 조건** ✅: done 이벤트 수신 시 result 텍스트 표시 + "Copy Result" 클릭 시 클립보드에 복사됨.

#### FR-5: 작업 취소 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-5.1 | 취소 요청 | `POST /inference/cancel/{job_id}` | DONE |
| FR-5.2 | 즉시 반영 | Rust 측에서 즉시 CANCELED 상태 업데이트 | DONE |
| FR-5.3 | SSE 동기화 | SSE `cancelled` 이벤트로 최종 확인 | DONE |

**완료 조건** ✅: 취소 클릭 → Rust 즉시 CANCELED 반영 → SSE cancelled 이벤트로 최종 확인. UI에 CANCELED 뱃지 표시.

#### FR-6: 다중 작업 관리 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-6.1 | 동시 실행 | HashMap<String, Job>으로 복수 작업 관리 | DONE |
| FR-6.2 | 작업 목록 | JobList 컴포넌트에서 모든 작업 표시 | DONE |
| FR-6.3 | 개별 카드 | JobCard별 상태 뱃지, 진행률, 결과, 취소 버튼 | DONE |

**완료 조건** ✅: 복수 작업 동시 실행 시 각각 독립적으로 진행률/상태가 업데이트. JobList에 모든 작업이 표시.

#### FR-7: 초기 셋업 ✅

| ID | 요구사항 | 설명 | 상태 |
|----|----------|------|------|
| FR-7.1 | 셋업 체크 | SHA-256(requirements.txt) vs 마커 파일 비교 | DONE |
| FR-7.2 | pip 부트스트랩 | `get-pip.py --no-user --target <env_dir>` | DONE |
| FR-7.3 | 패키지 설치 | `pip install -r requirements.txt --target <env_dir>` | DONE |
| FR-7.4 | 경로 패치 | `python312._pth`에 env_dir 삽입 | DONE |
| FR-7.5 | 진행률 UI | SetupScreen 컴포넌트: 단계별 프로그레스 바 | DONE |
| FR-7.6 | 에러 재시도 | 실패 시 에러 화면 + Retry 버튼 | DONE |
| FR-7.7 | 셋업 리셋 | `reset_setup` 커맨드: 마커 + python-env 삭제 | DONE |

**완료 조건** ✅: 최초 실행 시 셋업 화면 → pip 부트스트랩 + 패키지 설치 → 마커 저장 → 다음 실행 시 셋업 스킵. `reset_setup` 후 재시작 시 셋업 재실행.

---

## 4. 비기능 요구사항 (Non-Functional Requirements)

| ID | 항목 | 요구사항 | 설명 | 완료 조건 |
|----|------|----------|------|----------|
| NFR-1 | 안정성 | 초기 헬스체크 | 30초 타임아웃 후 ERROR 상태 전환 + 프로세스 정리 | DONE. 향후: 런타임 크래시 감지, 자동 재시작 |
| NFR-2 | 반응성 | 비동기 처리 | Rust: tokio async/await, Python: asyncio + FastAPI | DONE |
| NFR-3 | 보안 | 로컬 바인딩 | Python 서버 127.0.0.1 전용 (외부 접근 차단) | DONE |
| NFR-4 | 격리 | 프로세스 분리 | Python 서버 별도 프로세스, `CREATE_NO_WINDOW` 플래그 | DONE |
| NFR-5 | 배포성 | NSIS 설치파일 | Windows NSIS `.exe` 인스톨러 생성 | DONE |
| NFR-6 | 이식성 | 내장 Python | Windows embeddable Python 3.12.8 번들 (~22MB) | DONE |
| NFR-7 | 오프라인 | 로컬 동작 | 모델 다운로드 완료 후 인터넷 없이 STT + 번역 가능 | 모델 다운로드 후 네트워크 차단 상태에서 전체 파이프라인 동작 |
| NFR-8 | 성능 | STT 속도 | Whisper base 모델 기준 real-time factor ≤ 0.5 (CPU) | 5분 오디오 → 2.5분 이내 STT 완료 (base, CPU) |
| NFR-9 | 성능 | 번역 속도 | Qwen3 Q4_K_M 기준 세그먼트당 ≤ 5초 (CPU) | 100 세그먼트 → 8분 이내 번역 완료 |
| NFR-10 | UX | 첫 실행 | 위자드 완료까지 5분 이내 (다운로드 시간 제외) | 위자드 단계 수 ≤ 5, 각 단계 평균 1분 |

---

## 5. 기술 스택

### 5.1 프론트엔드

| 라이브러리 | 버전 | 용도 |
|-----------|------|------|
| React | 18.3.1 | UI 프레임워크 |
| TypeScript | 5.6.2 | 타입 안전성 |
| Vite | 6.0.0 | 빌드 도구 |
| @tauri-apps/api | 2.x | Tauri IPC 바인딩 |
| @tauri-apps/plugin-dialog | 2.x | 파일/폴더 선택 다이얼로그 (**신규**) |

### 5.2 Rust (Tauri)

| 크레이트 | 버전 | 용도 |
|----------|------|------|
| tauri | 2.x | 데스크톱 프레임워크 |
| tauri-plugin-shell | 2.x | 프로세스 실행 |
| tauri-plugin-dialog | 2.x | 파일/폴더 다이얼로그 (**신규**) |
| reqwest | 0.12 | HTTP 클라이언트 + 모델 다운로드 |
| reqwest-eventsource | 0.6 | SSE 클라이언트 |
| tokio | 1.x | 비동기 런타임 |
| uuid | 1.x | 작업 ID 생성 |
| sha2 | 0.10 | 셋업 해시 검증 + 모델 해시 검증 |
| serde / serde_json | — | 직렬화 |
| sysinfo | 0.33 | CPU/RAM/디스크 정보 (**신규**) |

### 5.3 Python 서버

| 패키지 | 버전 | 용도 |
|--------|------|------|
| fastapi | ≥0.115.0 | REST API |
| uvicorn | ≥0.34.0 | ASGI 서버 |
| sse-starlette | ≥2.2.0 | SSE 스트리밍 |
| faster-whisper | ≥1.1.0 | STT 엔진 (**신규**) |
| llama-cpp-python | ≥0.3.0 | LLM 추론 (**신규**) |
| pynvml | ≥12.0.0 | GPU 모니터링 (**신규**, optional) |

---

## 6. 데이터 구조

### 6.1 디렉토리 레이아웃

```
%APPDATA%/LocalSub/
├── config.json                    # 앱 설정 (위자드 완료 상태, 언어, 포맷 등)
├── setup-complete.marker          # pip 셋업 해시 (기존)
├── python-env/                    # pip 패키지 (기존)
├── models/
│   ├── manifest.json              # 설치된 모델 상태 기록
│   ├── whisper/
│   │   ├── tiny/                  # faster-whisper tiny 모델 파일들
│   │   ├── base/
│   │   ├── small/
│   │   ├── medium/
│   │   └── large-v3/
│   └── llm/
│       └── qwen3-{variant}.gguf   # GGUF 모델 파일 (단일 파일)
├── glossaries/
│   ├── default.json               # 기본 용어집
│   └── {custom}.json              # 사용자 커스텀 용어집
└── output/                        # 기본 출력 폴더 (config로 변경 가능)
```

### 6.2 config.json

```json
{
  "version": 1,
  "wizard_completed": true,
  "wizard_step": 5,
  "profile": "balanced",
  "output_dir": "C:/Users/{user}/Documents/Subtitles",
  "subtitle_format": "srt",
  "source_language": "auto",
  "target_language": "ko",
  "translation_mode": "local",
  "context_window": 2,
  "style_preset": "natural",
  "external_api": {
    "provider": null,
    "model": null
  },
  "model_dir": null,
  "ui_language": null,
  "active_whisper_model": null,
  "active_llm_model": null
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `active_whisper_model` | `string \| null` | 현재 사용할 Whisper 모델 ID (manifest의 id 값). null이면 미선택. |
| `active_llm_model` | `string \| null` | 현재 사용할 LLM 모델 ID (manifest의 id 값). null이면 미선택. |

> Settings → Models 탭에서 `status: "ready"` 상태인 모델 중 하나를 활성 모델로 선택할 수 있다.
> 선택 시 `update_config({ active_whisper_model: "<id>" })` 호출로 config.json에 영속화된다.

### 6.3 manifest.json

```json
{
  "version": 1,
  "updated_at": "2026-02-27T12:00:00Z",
  "models": [
    {
      "id": "whisper-base",
      "type": "whisper",
      "name": "Whisper Base",
      "path": "whisper/base",
      "size_bytes": 145000000,
      "sha256": "abc123...",
      "status": "ready",
      "installed_at": "2026-02-27T12:00:00Z"
    },
    {
      "id": "qwen3-8b-q5km",
      "type": "llm",
      "name": "Qwen3-8B Q5_K_M",
      "path": "llm/qwen3-8b-q5_k_m.gguf",
      "size_bytes": 5800000000,
      "sha256": "def456...",
      "status": "ready",
      "installed_at": "2026-02-27T12:00:00Z"
    }
  ]
}
```

모델 status 값: `downloading` | `verifying` | `ready` | `missing` | `corrupt`

### 6.4 model_catalog.json (Rust 번들 리소스)

```json
{
  "version": 1,
  "whisper_models": [
    {
      "id": "whisper-tiny",
      "name": "Whisper Tiny",
      "repo": "Systran/faster-whisper-tiny",
      "files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
      "total_size_bytes": 77000000,
      "sha256": { "model.bin": "..." },
      "profiles": ["lite"]
    },
    {
      "id": "whisper-base",
      "name": "Whisper Base",
      "repo": "Systran/faster-whisper-base",
      "files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
      "total_size_bytes": 145000000,
      "sha256": { "model.bin": "..." },
      "profiles": ["lite", "balanced"]
    },
    {
      "id": "whisper-small",
      "name": "Whisper Small",
      "repo": "Systran/faster-whisper-small",
      "files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
      "total_size_bytes": 488000000,
      "sha256": { "model.bin": "..." },
      "profiles": ["balanced"]
    },
    {
      "id": "whisper-medium",
      "name": "Whisper Medium",
      "repo": "Systran/faster-whisper-medium",
      "files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
      "total_size_bytes": 1530000000,
      "sha256": { "model.bin": "..." },
      "profiles": ["balanced", "power"]
    },
    {
      "id": "whisper-large-v3",
      "name": "Whisper Large V3",
      "repo": "Systran/faster-whisper-large-v3",
      "files": ["model.bin", "config.json", "tokenizer.json", "vocabulary.json"],
      "total_size_bytes": 3090000000,
      "sha256": { "model.bin": "..." },
      "profiles": ["power"]
    }
  ],
  "llm_models": [
    {
      "id": "qwen3-4b-q4km",
      "name": "Qwen3-4B Q4_K_M",
      "repo": "Qwen/Qwen3-4B-GGUF",
      "filename": "qwen3-4b-q4_k_m.gguf",
      "size_bytes": 2800000000,
      "sha256": "...",
      "quant": "Q4_K_M",
      "profiles": ["lite"],
      "n_gpu_layers_default": 0
    },
    {
      "id": "qwen3-8b-q5km",
      "name": "Qwen3-8B Q5_K_M",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "filename": "qwen3-8b-q5_k_m.gguf",
      "size_bytes": 5800000000,
      "sha256": "...",
      "quant": "Q5_K_M",
      "profiles": ["balanced"],
      "n_gpu_layers_default": 28
    },
    {
      "id": "qwen3-14b-q8",
      "name": "Qwen3-14B Q8_0",
      "repo": "Qwen/Qwen3-14B-GGUF",
      "filename": "qwen3-14b-q8_0.gguf",
      "size_bytes": 15000000000,
      "sha256": "...",
      "quant": "Q8_0",
      "profiles": ["power"],
      "n_gpu_layers_default": -1
    }
  ]
}
```

---

## 7. 프로젝트 구조

```
tauri-ai-sse/
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                  # 앱 진입점, 커맨드 등록 (기존 9 + 신규 19)
│   │   ├── main.rs                 # Windows 콘솔 숨김
│   │   ├── commands.rs             # 기존 Tauri IPC 커맨드 (9개)
│   │   ├── commands_wizard.rs      # 위자드 관련 커맨드 (신규)
│   │   ├── commands_model.rs       # 모델 관리 커맨드 (신규)
│   │   ├── commands_stt.rs         # STT 커맨드 (신규)
│   │   ├── commands_translate.rs   # 번역 커맨드 (신규)
│   │   ├── commands_runtime.rs     # 런타임 관리 커맨드 (신규)
│   │   ├── commands_config.rs      # 설정 관리 커맨드 (신규)
│   │   ├── python_manager.rs       # 프로세스 시작/중지/헬스체크
│   │   ├── setup_manager.rs        # 셋업 (pip, 패키지, _pth 패치)
│   │   ├── model_downloader.rs     # 모델 다운로드 (reqwest + Range) (신규)
│   │   ├── hw_detector.rs          # HW 진단 (CPU/RAM/GPU) (신규)
│   │   ├── config_manager.rs       # config.json 읽기/쓰기 (신규)
│   │   ├── sse_client.rs           # SSE 구독 클라이언트
│   │   ├── job.rs                  # Job, JobState, SseEvent 타입
│   │   ├── state.rs                # AppState, SharedState (확장)
│   │   └── error.rs                # AppError enum (확장)
│   ├── resources/
│   │   ├── python-embed/           # Python 3.12.8 embeddable (~22MB)
│   │   ├── get-pip.py              # pip 부트스트래퍼 (~2.2MB)
│   │   ├── python-server/          # 빌드 시 복사되는 서버 코드
│   │   └── model_catalog.json      # 모델 카탈로그 (신규)
│   ├── tauri.conf.json             # Tauri 설정 (NSIS 번들)
│   └── Cargo.toml
├── src/
│   ├── App.tsx                     # 메인 컴포넌트 (위자드 플로 추가)
│   ├── components/
│   │   ├── SetupScreen.tsx         # pip 셋업 진행 화면
│   │   ├── ServerControl.tsx       # 서버 제어 패널
│   │   ├── InferenceForm.tsx       # 추론 입력 폼 → STT 입력 폼으로 확장
│   │   ├── JobList.tsx             # 작업 목록
│   │   ├── JobCard.tsx             # 개별 작업 카드
│   │   ├── wizard/                 # 위자드 컴포넌트 (신규)
│   │   │   ├── WizardLayout.tsx    # 위자드 레이아웃 (스텝 인디케이터)
│   │   │   ├── StepWelcome.tsx     # 1단계: 환영
│   │   │   ├── StepEnvironment.tsx # 2단계: 환경 진단
│   │   │   ├── StepOutput.tsx      # 3단계: 출력 설정
│   │   │   ├── StepModels.tsx      # 4단계: 모델 선택
│   │   │   └── StepInstall.tsx     # 5단계: 다운로드 + 설치
│   │   ├── translate/              # 번역 관련 컴포넌트 (신규)
│   │   │   ├── TranslatePanel.tsx  # 번역 작업 패널
│   │   │   ├── SubtitlePreview.tsx # 자막 미리보기 (원본 + 번역)
│   │   │   └── RuntimeStatus.tsx   # LLM/Whisper 런타임 상태 표시
│   │   └── settings/               # 설정 컴포넌트 (신규)
│   │       ├── SettingsPanel.tsx   # 설정 메인 패널
│   │       ├── ModelManager.tsx    # 모델 관리 (설치/삭제)
│   │       ├── GlossaryEditor.tsx  # 용어집 편집기
│   │       └── ApiSettings.tsx     # 외부 API 설정
│   ├── hooks/
│   │   ├── useSetup.ts             # 셋업 상태 훅
│   │   ├── useServerStatus.ts      # 서버 상태 훅
│   │   ├── useJobs.ts              # 작업 관리 훅
│   │   ├── useWizard.ts            # 위자드 상태 훅 (신규)
│   │   ├── useConfig.ts            # 설정 관리 훅 (신규)
│   │   ├── useModels.ts            # 모델 관리 훅 (신규)
│   │   └── useRuntime.ts           # 런타임 상태 훅 (신규)
│   ├── lib/
│   │   └── tauriApi.ts             # Tauri 커맨드 래퍼 (확장)
│   └── types.ts                    # 공통 타입 정의 (확장)
├── python-server/
│   ├── main.py                     # FastAPI 앱 + Uvicorn 실행 (라우터 분리)
│   ├── inference.py                # 추론 로직 (기존 mock 유지)
│   ├── stt_router.py               # STT 엔드포인트 (신규)
│   ├── translate_router.py         # 번역 엔드포인트 (신규)
│   ├── runtime_router.py           # 런타임 관리 엔드포인트 (신규)
│   ├── stt_engine.py               # faster-whisper 래퍼 (신규)
│   ├── llm_engine.py               # llama-cpp-python 래퍼 (신규)
│   ├── prompt_builder.py           # 번역 프롬프트 생성기 (신규)
│   ├── subtitle_formatter.py       # SRT/VTT/ASS 포매터 (신규)
│   ├── models.py                   # Pydantic 모델 (확장)
│   └── requirements.txt            # Python 의존성 (확장)
└── scripts/
    └── download-python-embed.ps1   # Python embeddable 다운로드 스크립트
```

---

## 8. Tauri IPC 커맨드

### 8.1 기존 커맨드 (9개)

| 커맨드 | 인자 | 반환 | 설명 | 상태 |
|--------|------|------|------|------|
| `check_setup` | — | `SetupStatus` | 셋업 완료 여부 확인 | DONE |
| `run_setup` | — | `()` | 셋업 실행 (이벤트 방출) | DONE |
| `reset_setup` | — | `()` | 셋업 초기화 | DONE |
| `start_server` | — | `()` | Python 서버 시작 | DONE |
| `stop_server` | — | `()` | Python 서버 중지 | DONE |
| `get_server_status` | — | `ServerStatus` | 현재 서버 상태 | DONE |
| `start_inference` | `input_text: String` | `Job` | 추론 시작 → SSE 자동 구독 | DONE |
| `cancel_job` | `job_id: String` | `()` | 작업 취소 | DONE |
| `get_jobs` | — | `Vec<Job>` | 전체 작업 목록 | DONE |

### 8.2 신규 커맨드 — 위자드 (4개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `detect_hardware` | — | `HardwareInfo` | CPU/RAM/GPU/디스크 정보 수집 |
| `recommend_profile` | `hw: HardwareInfo` | `ProfileRecommendation` | HW 기반 프로파일 추천 |
| `get_model_catalog` | — | `ModelCatalog` | 번들된 모델 카탈로그 반환 |
| `check_disk_space` | `path: String` | `DiskSpace` | 경로의 가용 디스크 공간 확인 |

### 8.3 신규 커맨드 — 모델 관리 (5개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `download_model` | `model_id: String` | `()` | 모델 다운로드 시작 (이벤트로 진행률 방출) |
| `cancel_download` | `model_id: String` | `()` | 다운로드 취소 |
| `delete_model` | `model_id: String` | `()` | 모델 파일 삭제 + manifest 업데이트 |
| `get_model_manifest` | — | `ModelManifest` | 설치된 모델 목록 반환 |
| `verify_model` | `model_id: String` | `VerifyResult` | 모델 파일 해시 검증 |

### 8.4 신규 커맨드 — STT (2개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `start_stt` | `file_path: String, language: Option<String>` | `Job` | STT 작업 시작 |
| `cancel_stt` | `job_id: String` | `()` | STT 작업 취소 |

### 8.5 신규 커맨드 — 번역 (3개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `start_translate` | `job_id: String, segments: Vec<Segment>` | `Job` | 번역 작업 시작 (STT 결과 전달) |
| `cancel_translate` | `job_id: String` | `()` | 번역 작업 취소 |
| `start_stt_and_translate` | `file_path: String, language: Option<String>` | `Job` | STT + 번역 파이프라인 일괄 실행 |

### 8.6 신규 커맨드 — 런타임 (2개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `get_runtime_status` | — | `RuntimeStatus` | Whisper/LLM 모델 로드 상태 |
| `get_resource_usage` | — | `ResourceUsage` | RAM/VRAM 사용량 |

### 8.7 신규 커맨드 — 설정 (2개)

| 커맨드 | 인자 | 반환 | 설명 |
|--------|------|------|------|
| `get_config` | — | `AppConfig` | 전체 설정 반환 |
| `update_config` | `partial: PartialConfig` | `AppConfig` | 설정 부분 업데이트 |

> `save_glossary` / 레거시 파일-glossary 시스템은 제거됨. 용어집은 vocabulary 시스템(프리셋 `vocabulary_id`)으로 일원화. 용어 관리는 `commands_vocabulary::{add,update,remove}_vocabulary` 사용.

---

## 9. 이벤트

### 9.1 기존 이벤트 (3개)

| 이벤트명 | 페이로드 | 발생 시점 | 상태 |
|----------|----------|----------|------|
| `server-status` | `ServerStatus` | 서버 상태 변경 시 | DONE |
| `job-updated` | `Job` | 작업 상태/진행률 변경 시 | DONE |
| `setup-progress` | `{ stage, message, progress }` | 셋업 진행 중 | DONE |

### 9.2 신규 이벤트 (4개)

| 이벤트명 | 페이로드 | 발생 시점 |
|----------|----------|----------|
| `download-progress` | `{ model_id, downloaded, total, speed_bps, eta_secs }` | 모델 다운로드 진행 중 |
| `stt-segment` | `{ job_id, index, start, end, text }` | STT 세그먼트 생성 시 |
| `translate-segment` | `{ job_id, index, original, translated, tokens }` | 번역 세그먼트 완료 시 |
| `runtime-status` | `{ whisper: Status, llm: Status }` | 런타임 상태 변경 시 |

---

## 10. Python 서버 엔드포인트

### 10.1 기존 엔드포인트 (4개)

| 메서드 | 경로 | 설명 | 상태 |
|--------|------|------|------|
| GET | `/health` | 헬스체크 | DONE |
| POST | `/inference/start` | 추론 시작 (mock) | DONE |
| GET | `/inference/stream/{job_id}` | SSE 스트리밍 | DONE |
| POST | `/inference/cancel/{job_id}` | 추론 취소 | DONE |

### 10.2 신규 엔드포인트 — STT (3개)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/stt/start` | STT 시작 (file_path, language, model_id) → job_id |
| GET | `/stt/stream/{job_id}` | STT SSE 스트리밍 (segment 이벤트) |
| POST | `/stt/cancel/{job_id}` | STT 취소 |

### 10.3 신규 엔드포인트 — 번역 (3개)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/translate/start` | 번역 시작 (segments, config) → job_id |
| GET | `/translate/stream/{job_id}` | 번역 SSE 스트리밍 (token/segment 이벤트) |
| POST | `/translate/cancel/{job_id}` | 번역 취소 |

### 10.4 신규 엔드포인트 — 런타임 (4개)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/runtime/load-whisper` | Whisper 모델 로드 (model_path, compute_type) |
| POST | `/runtime/load-llm` | LLM 모델 로드 (model_path, n_gpu_layers, n_ctx) |
| POST | `/runtime/unload/{type}` | 모델 언로드 (whisper \| llm) |
| GET | `/runtime/status` | 런타임 상태 반환 (whisper, llm 각각의 로드 상태) |

---

## 11. 빌드 및 배포

### 11.1 프론트엔드 빌드

```bash
npm run build          # Vite → dist/
```

### 11.2 Python 서버 패키징 — 내장 Python 전략

PyInstaller로 exe를 만드는 대신, **Windows embeddable Python을 번들**하고
최초 실행 시 런타임에 pip install을 수행한다.

#### 11.2.1 빌드 시 준비

| 단계 | 설명 |
|------|------|
| 1 | `scripts/download-python-embed.ps1` 실행 → `src-tauri/resources/python-embed/` 에 Python 3.12.8 embeddable 배치 |
| 2 | `get-pip.py` 를 `src-tauri/resources/` 에 배치 |
| 3 | `python-server/` 소스를 `src-tauri/resources/python-server/` 에 복사 |
| 4 | `model_catalog.json` 을 `src-tauri/resources/` 에 배치 (**신규**) |

#### 11.2.2 런타임 셋업 과정

```
앱 최초 실행
  ├─ config.json 존재 여부 체크 → 없으면 위자드 시작
  ├─ 위자드 완료 (모델 다운로드 포함)
  ├─ SHA-256(requirements.txt) vs setup-complete.marker 비교
  ├─ 불일치 → 셋업 시작
  │   ├─ python312._pth 패치 (env_dir 추가)
  │   ├─ python get-pip.py --no-user --target %APPDATA%/.../python-env/
  │   ├─ pip install -r requirements.txt --no-user --target %APPDATA%/.../python-env/
  │   └─ setup-complete.marker에 SHA-256 해시 저장
  └─ 일치 → 셋업 스킵 → 서버 시작
```

#### 11.2.3 환경 변수

서버 실행 시 설정되는 환경 변수:

| 변수 | 값 | 설명 |
|------|----|------|
| `PYTHONPATH` | `%APPDATA%/.../python-env/` | 패키지 검색 경로 |
| `PIP_TARGET` | `%APPDATA%/.../python-env/` | pip 설치 대상 |
| `PIP_NO_USER` | `1` | --user 설치 방지 |
| `PATH` | `python-embed;env/bin;기존PATH` | 실행 파일 검색 |
| `MODEL_DIR` | `%APPDATA%/.../models/` | 모델 저장 경로 (**신규**) |

### 11.3 Tauri 빌드

```bash
npm run tauri build    # NSIS .exe 설치파일 생성
```

**출력**: `src-tauri/target/release/bundle/nsis/AI Subtitle Translator_0.2.0_x64-setup.exe`

**번들 리소스 매핑** (`tauri.conf.json`):

| 소스 | 설치 경로 |
|------|----------|
| `resources/python-embed/*` | `python-embed/` |
| `resources/get-pip.py` | `get-pip.py` |
| `resources/python-server/*` | `python-server/` |
| `resources/model_catalog.json` | `model_catalog.json` |

---

## 12. 구현 체크리스트

### Sprint 1: 인프라 — HW 진단 + 설정 관리

> 목표: 위자드의 기반이 되는 HW 진단과 설정 영속화 구축

- [ ] `src-tauri/src/hw_detector.rs` 생성 — CPU (코어, AVX), RAM, 디스크, GPU (nvidia-smi) 감지
- [ ] `src-tauri/src/config_manager.rs` 생성 — config.json CRUD + 기본값 생성
- [ ] `src-tauri/src/commands_wizard.rs` 생성 — `detect_hardware`, `recommend_profile`, `get_model_catalog`, `check_disk_space`
- [ ] `src-tauri/src/commands_config.rs` 생성 — `get_config`, `update_config`, `save_glossary`
- [ ] `src-tauri/src/state.rs` 확장 — `AppConfig`, `HardwareInfo`, `DiskSpace` 타입 추가
- [ ] `src-tauri/src/error.rs` 확장 — Config, Hardware, Download 에러 변형 추가
- [ ] `src-tauri/src/lib.rs` 수정 — 신규 커맨드 등록
- [ ] `src-tauri/resources/model_catalog.json` 생성 — Whisper 5종 + Qwen3 GGUF 3종
- [ ] `src-tauri/Cargo.toml` 수정 — `sysinfo`, `tauri-plugin-dialog` 의존성 추가
- [ ] `src/types.ts` 확장 — HardwareInfo, AppConfig, ModelCatalog, Profile 등 타입 추가
- [ ] `src/lib/tauriApi.ts` 확장 — 신규 커맨드 래퍼 추가
- [ ] 단위 테스트: HW 진단이 실제 값을 반환하는지 검증

### Sprint 2: 모델 다운로드 엔진

> 목표: Rust에서 HuggingFace 모델을 직접 다운로드 (이어받기 + 해시 검증)

- [ ] `src-tauri/src/model_downloader.rs` 생성 — reqwest 기반 다운로드, Range 헤더 resume, SHA-256 검증
- [ ] `src-tauri/src/commands_model.rs` 생성 — `download_model`, `cancel_download`, `delete_model`, `get_model_manifest`, `verify_model`
- [ ] manifest.json 읽기/쓰기 로직 구현 (model_downloader.rs 내)
- [ ] `download-progress` 이벤트 방출 — `{ model_id, downloaded, total, speed_bps, eta_secs }`
- [ ] 다운로드 취소 로직 — tokio CancellationToken
- [ ] 모델 삭제 로직 — 파일 삭제 + manifest 동기화
- [ ] 모델 무결성 검증 — 앱 시작 시 manifest 파일 존재/해시 체크
- [ ] `src-tauri/tauri.conf.json` 수정 — `model_catalog.json` 번들 리소스 추가
- [ ] 통합 테스트: 소규모 파일 다운로드 → 해시 검증 → manifest 기록

### Sprint 3: 위자드 UI

> 목표: 5단계 위자드 UI 완성 (Welcome → 환경 → 출력 → 모델 → 설치)

- [ ] `src/components/wizard/WizardLayout.tsx` 생성 — 스텝 인디케이터 + 이전/다음 버튼
- [ ] `src/components/wizard/StepWelcome.tsx` 생성 — 환영 메시지 + 시작 버튼
- [ ] `src/components/wizard/StepEnvironment.tsx` 생성 — HW 카드 (CPU/RAM/GPU/디스크) + 프로파일 선택
- [ ] `src/components/wizard/StepOutput.tsx` 생성 — 출력 폴더 선택 + 자막 포맷 + 언어 설정
- [ ] `src/components/wizard/StepModels.tsx` 생성 — 모델 선택 체크박스 + 크기 표시 + 총 다운로드 크기
- [ ] `src/components/wizard/StepInstall.tsx` 생성 — 다운로드 진행률 + pip 셋업 + 완료 화면
- [ ] `src/hooks/useWizard.ts` 생성 — 위자드 상태 관리 (단계, 선택값, 진행률)
- [ ] `src/hooks/useModels.ts` 생성 — 모델 카탈로그/manifest 조회, 다운로드 이벤트 리스닝
- [ ] `src/App.tsx` 수정 — 위자드 조건 분기 추가 (config.wizard_completed 체크)
- [ ] `src/App.css` 확장 — 위자드 레이아웃 스타일
- [ ] E2E 테스트: 위자드 전체 플로 (모의 다운로드로)

### Sprint 4: faster-whisper STT 파이프라인

> 목표: 오디오 파일 → 자막 세그먼트 생성 (SSE 스트리밍)

- [ ] `python-server/stt_engine.py` 생성 — faster-whisper 래퍼 (모델 로드, transcribe, 세그먼트 제너레이터)
- [ ] `python-server/stt_router.py` 생성 — `/stt/start`, `/stt/stream/{job_id}`, `/stt/cancel/{job_id}`
- [ ] `python-server/subtitle_formatter.py` 생성 — SRT/VTT/ASS 포매터
- [ ] `python-server/main.py` 수정 — stt_router 등록
- [ ] `python-server/requirements.txt` 수정 — `faster-whisper>=1.1.0` 추가
- [ ] `src-tauri/src/commands_stt.rs` 생성 — `start_stt`, `cancel_stt`
- [ ] `src-tauri/src/sse_client.rs` 확장 — STT SSE 이벤트 파싱 (stt-segment 이벤트 방출)
- [ ] `stt-segment` 이벤트 구현 — `{ job_id, index, start, end, text }`
- [ ] 통합 테스트: 짧은 오디오 → STT → SRT 파일 생성 검증

### Sprint 5: llama-cpp-python 번역 파이프라인

> 목표: STT 결과 → Qwen3 로컬 번역 (컨텍스트 윈도우 + 토큰 스트리밍)

- [ ] `python-server/llm_engine.py` 생성 — llama-cpp-python 래퍼 (모델 로드/언로드, generate, VRAM fallback)
- [ ] `python-server/prompt_builder.py` 생성 — 컨텍스트 윈도우 프롬프트 구성, 용어집 주입, 스타일 프리셋 적용
- [ ] `python-server/translate_router.py` 생성 — `/translate/start`, `/translate/stream/{job_id}`, `/translate/cancel/{job_id}`
- [ ] `python-server/main.py` 수정 — translate_router 등록
- [ ] `python-server/requirements.txt` 수정 — `llama-cpp-python>=0.3.0` 추가
- [ ] `src-tauri/src/commands_translate.rs` 생성 — `start_translate`, `cancel_translate`, `start_stt_and_translate`
- [ ] `src-tauri/src/sse_client.rs` 확장 — 번역 SSE 이벤트 파싱 (translate-segment 이벤트 방출)
- [ ] `translate-segment` 이벤트 구현 — `{ job_id, index, original, translated, tokens }`
- [ ] 통합 테스트: mock 세그먼트 → Qwen3 번역 → 이중 자막 SRT 생성 검증

### Sprint 6: 런타임 관리

> 목표: Whisper/LLM 모델 로드/언로드 + 리소스 모니터링

- [ ] `python-server/runtime_router.py` 생성 — `/runtime/load-whisper`, `/runtime/load-llm`, `/runtime/unload/{type}`, `/runtime/status`
- [ ] `python-server/main.py` 수정 — runtime_router 등록
- [ ] `python-server/requirements.txt` 수정 — `pynvml>=12.0.0` 추가 (optional)
- [ ] `src-tauri/src/commands_runtime.rs` 생성 — `get_runtime_status`, `get_resource_usage`
- [ ] `runtime-status` 이벤트 구현 — `{ whisper: Status, llm: Status }`
- [ ] VRAM 부족 시 n_gpu_layers 자동 조절 로직 (llm_engine.py)
- [ ] `src/components/translate/RuntimeStatus.tsx` 생성 — 런타임 상태 카드
- [ ] 통합 테스트: 모델 로드 → 상태 READY → 언로드 → UNLOADED 전이 검증

### Sprint 7: 번역 UI + 설정 패널

> 목표: 번역 워크플로 UI + 전체 설정 화면

- [ ] `src/components/translate/TranslatePanel.tsx` 생성 — 파일 선택 + STT/번역 시작 + 진행률
- [ ] `src/components/translate/SubtitlePreview.tsx` 생성 — 세그먼트 미리보기 (원본 + 번역 나란히)
- [ ] `src/components/settings/SettingsPanel.tsx` 생성 — 프로파일/출력/번역 설정 탭
- [ ] `src/components/settings/ModelManager.tsx` 생성 — 설치된 모델 목록 + 삭제 + 추가 다운로드
- [ ] `src/components/settings/GlossaryEditor.tsx` 생성 — 용어 추가/삭제/편집 + JSON 저장
- [ ] `src/components/settings/ApiSettings.tsx` 생성 — 프로바이더/키/테스트 연결
- [ ] `src/hooks/useConfig.ts` 생성 — 설정 로드/저장 훅
- [ ] `src/hooks/useRuntime.ts` 생성 — 런타임 상태 + 리소스 모니터링 훅
- [ ] `src/App.tsx` 수정 — 메인 레이아웃에 탭 네비게이션 (번역 | 설정)
- [ ] `src/App.css` 확장 — 설정 패널 + 자막 미리보기 스타일

### Sprint 8: 통합 + 검증

> 목표: 전체 파이프라인 통합 테스트 + 엣지 케이스 처리

- [ ] 전체 플로 테스트: 위자드 → 모델 다운로드 → 서버 시작 → STT → 번역 → SRT 저장
- [ ] 오프라인 모드 테스트: 네트워크 차단 후 STT + 번역 동작 확인
- [ ] 프로파일별 테스트: Lite (CPU only) / Balanced (GPU partial) / Power (GPU full)
- [ ] 대용량 파일 테스트: 1시간 오디오 → 메모리 누수/크래시 없이 완료
- [ ] 취소 테스트: STT 중 취소, 번역 중 취소, 다운로드 중 취소 + 이어받기
- [ ] 에러 복구 테스트: VRAM 부족 → fallback, 모델 파일 손상 → 재다운로드 안내
- [ ] 위자드 재진입 테스트: 중간 종료 → 재시작 → 이어서 진행
- [ ] requirements.txt 업데이트: `faster-whisper`, `llama-cpp-python`, `pynvml` 최종 버전 확정
- [ ] `python-server/` → `src-tauri/resources/python-server/` 동기화 스크립트 확인
- [ ] NSIS 빌드 + 설치 → 전체 플로 E2E

---

## 13. 완비/미완 분류

### DONE — 구현 완료 (20항목)

| # | 항목 | 코드 근거 |
|---|------|----------|
| 1 | FR-1.1 서버 시작 | `commands.rs:start_server`, `python_manager.rs:spawn_python_server` |
| 2 | FR-1.2 서버 중지 | `commands.rs:stop_server`, `python_manager.rs:kill_server` |
| 3 | FR-1.3 상태 표시 | `state.rs:ServerStatus` (4단계), `ServerControl.tsx` |
| 4 | FR-1.4 중복 방지 | `commands.rs:88` — RUNNING/STARTING 체크 |
| 5 | FR-1.5 헬스체크 | `python_manager.rs:wait_for_healthy` (60회 × 500ms) |
| 6 | FR-1.6 앱 종료 정리 | `lib.rs` — 종료 핸들러에서 kill + wait |
| 7 | FR-2 추론 시작 | `commands.rs:start_inference` → POST /inference/start |
| 8 | FR-3.1 SSE 구독 | `sse_client.rs:subscribe_to_job_stream` |
| 9 | FR-3.2 진행률 표시 | `JobCard.tsx` — ProgressBar + 메시지 |
| 10 | FR-3.3 이벤트 타입 | `job.rs:SseEvent` — progress/done/error/cancelled |
| 11 | FR-4.1 결과 표시 | `JobCard.tsx` — result 텍스트 표시 |
| 12 | FR-4.2 결과 복사 | `JobCard.tsx` — "Copy Result" 버튼 |
| 13 | FR-5 작업 취소 | `commands.rs:cancel_job` → POST /inference/cancel |
| 14 | FR-6 다중 작업 | `state.rs:jobs: HashMap<String, Job>` |
| 15 | FR-7 초기 셋업 전체 | `setup_manager.rs` — pip, requirements, _pth, 마커 |
| 16 | NFR-2 반응성 | tokio async/await (Rust) + asyncio (Python) |
| 17 | NFR-3 보안 (로컬) | `main.py:50` — `host="127.0.0.1"` |
| 18 | NFR-4 격리 | `python_manager.rs` — 별도 프로세스 + CREATE_NO_WINDOW |
| 19 | NFR-5 배포성 | `tauri.conf.json:26` — `"targets": ["nsis"]` |
| 20 | NFR-6 이식성 | `setup_manager.rs` — 내장 Python 3.12.8 embeddable |

### PARTIAL — 부분 구현 (2항목)

| # | 항목 | 구현 상태 | 미구현 부분 |
|---|------|----------|------------|
| 1 | NFR-1 안정성 | 초기 헬스체크 구현 (30초 대기) | 런타임 크래시 감지, 자동 재시작, 재연결 미구현 |
| 2 | 에러 처리 | AppError enum + 프론트 에러 표시 | 세분화된 에러 복구 전략 미구현 |

### NOT STARTED — Phase 1 신규 (Sprint 1–8)

| # | 항목 | Sprint | 설명 |
|---|------|--------|------|
| 1 | HW 진단 + 설정 관리 | Sprint 1 | `hw_detector.rs`, `config_manager.rs`, 위자드/설정 커맨드 |
| 2 | 모델 다운로드 엔진 | Sprint 2 | `model_downloader.rs`, manifest 관리, 이어받기/해시 검증 |
| 3 | 위자드 UI | Sprint 3 | 5단계 위자드 컴포넌트, 위자드 훅 |
| 4 | STT 파이프라인 | Sprint 4 | faster-whisper 통합, STT SSE, 자막 포매터 |
| 5 | 번역 파이프라인 | Sprint 5 | llama-cpp-python 통합, 컨텍스트 윈도우, 프롬프트 빌더 |
| 6 | 런타임 관리 | Sprint 6 | 모델 로드/언로드, 리소스 모니터, VRAM fallback |
| 7 | 번역 UI + 설정 | Sprint 7 | 번역 패널, 자막 미리보기, 설정 화면, 용어집 |
| 8 | 통합 검증 | Sprint 8 | E2E 테스트, 엣지 케이스, NSIS 빌드 검증 |

### NOT STARTED — Phase 1 이후

| # | 항목 | 설명 |
|---|------|------|
| 1 | 자동 업데이트 | Tauri updater 플러그인 (`tauri-plugin-updater` 미설치) |
| 2 | 로그 스트리밍 | 서버 로그 실시간 뷰어 UI |
| 3 | 코드 서명 | 인스톨러/실행파일 서명 (현재 unsigned) |
| 4 | vLLM 통합 | Linux/WSL 환경 GPU 가속 (Phase 2) |
| 5 | 다국어 UI | 앱 인터페이스 다국어 지원 |
