# LocalSub — 엔지니어링 가이드 및 아키텍처 규약 (CLAUDE.md)

LocalSub은 로컬 AI 기반 자막 생성 및 신경망 기계번역을 수행하는 온디바이스 데스크톱 애플리케이션입니다.

## 1. 기술 스택 (Tech Stack)

- **Frontend**: React 18 + TypeScript + Tailwind CSS v4 + Radix UI
- **Desktop Shell**: Tauri 2 (Rust) — IPC, 파일 시스템 I/O, 자식 프로세스 오케스트레이션
- **AI Inference Engine**: Python FastAPI (루프백 포트 `127.0.0.1:9111`)
  - 음성 인식 (STT): faster-whisper (CTranslate2). 음성 활동 감지(VAD)는 faster-whisper 내장 Silero VAD (`vad_filter=True`)
  - 신경망 기계번역 (Translation): llama-cpp-python (GGUF 양자화 모델)
  - 화자 분리 (Diarization): ONNX Runtime 음향 임베딩 + scikit-learn 응집 군집화(Agglomerative Clustering)
- **빌드 및 패키징**: Vite + Cargo + NSIS
- **테스트 스위트**: Vitest (프론트엔드) / pytest (Python 추론 서버) / `cargo test --lib` (Rust 코어 라이브러리)

## 2. 시스템 아키텍처 (System Architecture)

```
React UI (WebKit/WebView)
         ↕ (Tauri IPC Bridge: invoke / events)
Rust Backend Core (Process Management, Integrity, Hardware Detection)
         ↕ (HTTP REST / SSE Stream: 127.0.0.1:9111)
Python FastAPI Inference Subprocess
         ↓
AI Models (faster-whisper, llama-cpp-python, ONNX Runtime)
```

### 비디오 메모리(VRAM) 거버넌스 및 단계별 핸드오버
- Windows 환경에서 CTranslate2 기반 Whisper 런타임의 동적 언로드(`unload_runtime_model`) 호출 시 세그멘테이션 오류(Segmentation Fault)가 발생할 수 있습니다.
- 따라서 번역 단계 진입 전 **Python 추론 서버 프로세스를 정상 재시작**하여 Whisper가 점유하던 VRAM을 운영체제 차원에서 100% 완전 회수합니다 (`usePipeline.ts`).
- `restart_server`는 `nvidia-smi`를 통해 가용 VRAM이 6GB를 초과할 때까지 최대 20초간 대기한 후 자식 프로세스를 재스폰합니다.

## 3. 개발 및 빌드 환경 (Development & Build)

### 사전 요구 소프트웨어
- Node.js 18+, Rust 1.70+, Python 3.10+, CUDA Toolkit (GPU 빌드 시)
- Windows: Visual Studio Build Tools (MSVC 컴파일러) 및 Windows SDK

```bash
# 의존성 패키지 설치
npm install
pip install -r python-server/requirements.txt   # 또는 requirements.lock (전체 폐포 해시 핀)

# llama-cpp-python: 사전 컴파일된 휠만 설치 (소스 빌드 엄격 금지)
pip install llama-cpp-python==0.3.28 --only-binary llama-cpp-python \
  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# 개발 서버 실행
npm run tauri dev
```

> **Windows MSVC 환경 변수 필수 주의사항**:
> Windows 환경에서는 Cargo가 MSVC `link.exe` 링커 및 SDK 라이브러리를 정상 참조하도록 반드시 `vcvarsall.bat`으로 초기화된 셸 세션에서 빌드를 실행해야 합니다.
> 머신별 Visual Studio 에디션 및 Windows SDK 버전 차이로 인한 빌드 파단을 방지하기 위해 `src-tauri/.cargo/config.toml`에 절대 경로를 커밋하지 마십시오 (.gitignore 대상).

### 테스트 스위트 실행 규칙

```bash
# 프론트엔드 단위 테스트 (Vitest)
npm test

# Rust 코어 단위 테스트 (`--lib` 플래그 필수 — 바이너리 타깃에는 테스트 미포함)
cd src-tauri && cargo test --lib

# Python 단위 테스트 (경로 인자 `.` 필수 — 아래 격리 규칙 참조)
cd python-server && python -m pytest -q .
```

> **pytest 경로 인자 `.` 필수 지정 불변식**:
> pytest 실행 시 경로 인자 `.`을 생략할 경우 rootdir을 상위 디렉터리로 거슬러 탐색하여 상위 폴더의 무관한 테스트까지 수집(Collection)하게 됩니다.
> 또한 디렉토리 경로에 대괄호(`[projects] localsub`)가 포함된 환경에서는 pytest의 `path cannot contain [] parametrization` 오류가 유발될 수 있으므로 `pytest -q .` 형태를 엄격히 준수해야 합니다 (CI 워크플로 포함).

## 4. 핵심 디렉토리 및 모듈 구조

```
src/                  # React 프론트엔드 소스코드
src-tauri/src/        # Rust 백엔드 코어 (Tauri 명령 핸들러, 프로세스 및 무결성 관리)
python-server/        # FastAPI 기반 AI 추론 서버
  stt_engine.py       # STT 엔진 (faster-whisper, 60분 초과 미디어의 30분 청크 분할)
  llm_engine.py       # LLM 번역 엔진 (세그먼트 단위 추론, 롤링 요약, 품질 게이트)
  prompt_builder.py   # 번역 프롬프트 구성 모듈
  quality_filters.py  # 구조적 비-번역 탐지 (문자 집합/길이 비율/퇴행적 반복)
  embedding_gate.py   # 의미론적 거부 감지 게이트 (목표 언어 거부 응답 벡터 유사도 판별)
  translate_router.py # 번역 REST/SSE API 라우터
docs/                 # 시스템 설계 문서, 규격 사양서, 다이어그램, 기술 용어 사전
  glossary.md         # 정본 표준 기술 용어 사전
  specs/SPEC.md       # 시스템 요구사항 명세서 — 로컬 전용(gitignore), 공개 저장소에는 없음. 공개 문서에서 링크 금지
  diagrams/           # 아키텍처 및 파이프라인 SVG 다이어그램
```

Python 서버는 `/health` 엔드포인트 및 4개의 도메인 라우터(`/stt`, `/translate`, `/diarization`, `/runtime`)를 노출합니다.
장기 실행 작업은 모두 `POST .../start` → `GET .../stream/{job_id}`(SSE) → `POST .../cancel/{job_id}` 패턴을 따르며, 취소 처리는 협조적 플래그 폴링 방식으로 수행됩니다.

## 5. 모델 카탈로그 및 라이선스 정책 (Model Catalog & Licensing)

모델 메타데이터는 `src-tauri/resources/model_catalog.json`을 통해 관리됩니다.
Whisper 모델 구동에는 `model.bin`, `config.json`, `tokenizer.json`, `vocabulary.*`의 4개 파일이 요구되며, Whisper large-v3 및 kotoba-whisper-v2 모델의 경우 128 mel channel 처리를 위해 `preprocessor_config.json`이 필수적으로 포함되어야 합니다.

### LLM 카탈로그 등록 기준
1. **`model_category` 분류 기준**:
   - `"general"`: 프롬프트에 `/no_think` 디렉티브를 주입합니다 (Qwen3 전용 추론 제어 지시자).
   - **비-Qwen3 모델(Gemma, Qwen2.5 등)**: 불필요한 제어 토큰 노출을 방지하기 위해 **반드시 `"instruct"`로 지정**해야 합니다 (`prompt_builder.py` 참조).
   - 카탈로그 미등재 모델의 기본 폴백 카테고리는 `"instruct"`입니다 (`commands_translate.rs` 및 `prompt_builder.py`).
2. **소프트웨어 라이선스 준수**:
   - 카탈로그 등재는 직접 다운로드 링크 제공을 수반하므로 재배포가 공식 허용된 라이선스(Apache 2.0, MIT, Gemma 등) 모델만 등록합니다. 비상업 제한(NC) 모델, 특정 국가/지역 배제 조항이 포함된 모델은 등재 대상에서 제외합니다.
3. **무결성 검증**:
   - `sha256` 해시는 Hugging Face LFS OID를 기반으로 사전에 고정하며, 분할 파일 모델은 `split_files` 배열을 통해 관리합니다.

## 6. 번역 파이프라인 및 품질 게이트 (Translation Pipeline & Quality Gates)

1. **음성 인식 (Whisper)**: 오디오 신호 분석 및 타임스탬프 세그먼트 생성
2. **VRAM 회수 (Whisper 해제)**: 추론 서버 프로세스 정상 재시작 및 VRAM 확보
3. **미디어 컨텍스트 추론**: 초기 100개 세그먼트를 기반으로 장면 및 장르 문맥 추론
4. **LLM 모델 적재 및 세그먼트 번역**: 배치 처리가 아닌 개별 세그먼트 단위 순차 번역
5. **다단계 품질 게이트 평가**: 통과 실패 시 높은 Temperature 설정으로 1회 재시도 및 이상 플래그 설정
6. **롤링 요약 갱신**: 25개 세그먼트마다 점진 갱신, 누적 왜곡 방지를 위해 200개 세그먼트마다 전체 재생성
7. **프롬프트 단순성 유지**: 9B 이하 경량 모델의 환각을 최소화하기 위한 간결한 프롬프트 템플릿 유지

### 품질 게이트 평가 파이프라인 순서 (`llm_engine.py`의 `_bad_output_reason`)
1. `_looks_like_refusal`: 구문 기반 직접 거부 패턴 검출 (모델별 취약성 대응)
2. `quality_filters`: 모델 무관 구조적 필터링 (스크립트 누출, 언어 불일치, 토큰 길이 비정상 폭증, 퇴행적 반복)
3. `embedding_gate`: 최종 의미론적 거부 감지 (임베딩 벡터 코사인 유사도 판별)
- 환경변수 `LOCALSUB_DISABLE_EMBED_GATE`에 비어 있지 않은 값을 설정하면(`0` 포함) 임베딩 게이트를 비활성화합니다. 모델 파일(~250MB)이 없으면 번역 작업 시작 시 Hugging Face에서 SHA-256 고정으로 자동 다운로드하며, 다운로드·로드에 실패한 경우에만 no-op으로 전환됩니다(서버가 재시작될 때까지 유지).

> **`translation_mode` 식별자의 문맥별 다의성 주의사항**:
> - `config.translation_mode`: `"local"` / `"off"` (시스템 전역 번역 기능 활성화 여부 제어)
> - `preset.translation_mode`: `"direct"` / `"pivot_2pass"` (Python 추론 엔진으로 전달되는 번역 전략 파라미터)

## 7. 프로세스 오케스트레이션 및 결함 허용 (Process Orchestration & Fault Tolerance)

- Python 서버는 애플리케이션 시작 시 자동으로 스폰됩니다. `commands_runtime.rs`의 3초 주기 폴링이 10회 연속 실패할 경우 `server-crashed` 이벤트를 브로드캐스트하며, `usePipeline.ts`가 활성 파이프라인을 `failed`로 전이합니다.
- Rust 코어는 강제 자동 재시작 루프를 돌리지 않으며, 프론트엔드의 `useServerStatus.ts`가 `server-crashed` 이벤트 수신 후 3초 시점에 상태가 ERROR/STOPPED로 유지될 경우 `startServer()`를 원격 호출합니다 (의도적인 모델 스왑 재시작과의 경합 방지 가드 포함).
- **표준 에러(stderr) 스트림 캡처**: Python 자식 프로세스의 stderr는 `%APPDATA%/LocalSub/logs/python-stderr.log`로 리다이렉트되어 캡처됩니다 (2MB 초과 시 `.1` 파일로 롤링). Uvicorn 액세스 로그로 인한 표준 출력 오염을 방지하기 위해 stdout은 null 스트림으로 처리합니다.
- **`restart_server` 실패 상태 복원**: 서버 재시작 실패 시 반드시 `mark_server_failed`를 호출하여 상태를 ERROR로 전이시켜야 합니다. 상태 정리가 누락될 경우 사이드바 및 크래시 감지기가 비정상 고착될 수 있습니다.
- **`state.app_config` 지연 로딩 (Lazy Loading)**: 애플리케이션 시작 시 프론트엔드가 `getConfig`와 `getModelManifest`를 병렬 호출할 때 발생할 수 있는 레이스 컨디션을 방지하기 위해, 설정 접근 명령은 `config_manager::ensure_loaded(&mut s)`를 호출하여 필요 시점에 안전하게 초기화합니다.

## 8. 소프트웨어 공급망 무결성 정책 (Supply Chain Security Policy)

LocalSub은 최초 실행 셋업 시 다운로드되는 모든 외부 바이너리 및 패키지에 대해 엄격한 암호학적 검증을 적용합니다 (`src-tauri/src/integrity.rs` 및 `resources/integrity.json`).

1. **Python 패키지 폐포 무결성**:
   - `python-server/requirements.lock`을 통해 모든 패키지(전이 의존성 포함)의 SHA-256 해시를 고정하고 `pip install --require-hashes`로 설치를 강제합니다.
2. **`llama-cpp-python` 사전 컴파일 휠**:
   - 사전 빌드된 휠을 공식 릴리스로부터 직접 다운로드하여 SHA-256 검증 후 `pip install --no-deps`로 설치합니다. GPU 감지 결과에 따라 CUDA 휠(`0.3.31-cu124`) 또는 CPU 휠(`0.3.28`)을 선택합니다.
   - 휠 설치 시 `--upgrade` 옵션을 사용하지 않고 사전 제거 함수(`purge_installed_llama`)를 통해 기존 패키지 디렉토리 및 dist-info를 원자적으로 정리하여 파일 공유 충돌(Sharing Violation)을 방지합니다.
3. **FFmpeg 배포 규정 및 GPL 준수**:
   - FFmpeg 공식 Windows 빌드(GyanD/codexffmpeg 버전 태그 아카이브)를 업스트림으로부터 클라이언트가 직접 다운로드하도록 설계하여 제3자 미러링에 따른 GPLv3 전달자(Conveyer) 법적 의무를 배제합니다. 따라서 `FfmpegEntry`에는 미러 URL 필드가 존재하지 않으며, 임의의 미러 추가를 거부하는 단위 테스트(`bundled_ffmpeg_is_not_self_hosted`)가 유지됩니다.
4. **MSVC C++ 재배포 패키지 거버넌스 (`vcredist.rs`)**:
   - 임베디드 CPython 배포판에 포함되지 않은 네이티브 종속 DLL(`msvcp140.dll`, `vcomp140.dll` 등)의 부재로 인한 AI 백엔드 로드 실패를 방지하기 위해 시스템 전역 런타임 존재 여부를 `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_SYSTEM32)`로 정밀 검사합니다. 미설치 시 관리자 권한 상승(`Start-Process -Verb RunAs`)을 통해 공식 Microsoft CDN 고정 해시 인스톨러 설치를 안내합니다.
5. **정적 로컬 경로 누출 방지 가드 (`scripts/check-no-local-paths.mjs`)**:
   - 번들 리소스 및 Python 서버 소스코드 내에 개발자 로컬 절대 경로(`C:\Users\...`, `/home/...` 등)가 잔존할 경우 빌드를 강제 중단하는 정적 가드가 적용되어 있습니다.

## 9. CI 및 회귀 방지 체계

- GitHub Actions 워크플로(`.github/workflows/ci.yml`)는 프론트엔드 검증(`tsc`, `vitest`, `vite build`, `check:paths`), 락파일 무결성 검증(`requirements.lock` 해시 검증 및 requirements.txt 일치 검증), Python 전체 테스트 스위트(`python -m pytest -q .`)를 자동 실행합니다.
- Rust 단위 테스트는 로컬 환경에서 `cd src-tauri && cargo test --lib` 명령을 통해 정기 검증합니다.
