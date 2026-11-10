# 설계안: Qwen3-ASR STT 엔진 추가

- 상태: 구현 완료 (P0~P5, 2026-11-10). 실제 앱 종단 확인 진행
- 작성일: 2026-11-10
- 기준 커밋: `4f57884` (master, PR #19~#23 머지 후)

## 1. 목표와 범위

Qwen3-ASR(1.7B / 0.6B)을 faster-whisper 옆에 **두 번째 STT 엔진**으로 추가한다. 사용자는 모델 선택 화면에서 Whisper 계열과 Qwen 계열을 같은 목록에서 고르고, 이후 파이프라인(화자 분리 → VRAM 회수 재시작 → 번역)은 엔진과 무관하게 동일하게 동작한다.

**제0원칙: 최종 사용자는 일반인이다.** 사용자는 PyTorch·CUDA·엔진 팩 같은 것을 몰라도 된다. Qwen 모델을 고르면 필요한 모든 것이 자동으로 설치되어야 하고, 사용자가 해야 할 일은 "다운로드" 버튼 한 번이다. 따라서:
- 설치 화면과 오류 메시지에 기술 용어(torch, CUDA, pip, 엔진 팩)를 쓰지 않는다. 예: "Qwen 음성 인식 구성요소를 내려받는 중 (3.0GB / 9.5GB)".
- 엔진 팩 설치는 모델 다운로드와 하나의 진행 흐름으로 묶는다. 별도 설치 단계나 선택지를 노출하지 않는다.
- 의존성 충돌, 디스크 부족, 네트워크 실패는 앱이 해결하거나 사용자가 할 수 있는 행동("공간을 9.5GB 확보한 뒤 다시 시도")으로 안내한다.
- 이 원칙과 충돌하는 설계는 채택하지 않는다.

**비목표 (v1)**
- vLLM 백엔드. Windows 네이티브 미지원.
- 스트리밍 전사. Qwen 스트리밍은 vLLM 전용이고 타임스탬프가 없음.
- CPU 추론. 아래 §4.4 참조.
- Whisper 엔진 교체 또는 제거.

## 2. 사실 관계 (2026-11-10 확인)

| 항목 | 내용 | 출처 |
|---|---|---|
| 모델 | Qwen3-ASR-1.7B (~2B, 샤드 2개 합 ~4.7GB), Qwen3-ASR-0.6B (~0.9B, 1.88GB), Qwen3-ForcedAligner-0.6B (1.84GB). 모두 BF16 safetensors | HF 모델 카드 |
| 라이선스 | 세 모델 모두 Apache-2.0. 지역 배제·NC 조항 없음 → CLAUDE.md §5 등재 기준 충족 | HF 모델 카드, `qwen-asr` pyproject |
| ASR 언어 | 30개 언어 + 중국어 방언 22종 | HF, `qwen_asr/inference/utils.py` |
| 타임스탬프 | **ASR 단독으로는 없음.** `return_time_stamps=True`는 ForcedAligner가 없으면 `ValueError` | `qwen3_asr.py` |
| 정렬기 언어 | **11개뿐**: zh, en, yue, fr, de, it, ja, ko, pt, ru, es | HF ForcedAligner 카드 |
| 타임스탬프 단위 | 단어 단위, **초(float), 입력 구간 기준**. 한국어는 soynlp, 일본어는 nagisa로 어절·단어를 나눈다. 문장·세그먼트 단위는 없음 | **P0 확인** |
| 긴 오디오 | 패키지가 자체 분할. ASR 최대 1200초, 정렬 시 180초 청크. 무음 지점 탐색 방식 | `utils.py` |
| VAD | 없음 | 문서·코드 |
| 런타임 | `qwen-asr` 0.0.6 (순수 Python 휠). `transformers==4.57.6`, `accelerate==1.12.0` 고정. torch는 별도 설치. gradio·flask까지 의존성에 포함. **`transformers 4.57.6`은 `tokenizers<=0.23.0`, `huggingface_hub<1.0`을 요구해 현재 기본 lock(0.23.1, 1.19.0)과 충돌** | PyPI, pyproject, **P0 확인** |
| Windows | 공식 언급 없음. **임베디드 CPython 3.12.8 + torch 2.8.0+cu126에서 동작 확인** | **P0 확인** (§10) |
| VRAM | 실측(배치 8, bf16): 1.7B+정렬기 **~6.5GB**, 0.6B+정렬기 **~4.0GB** | **P0 실측** (§10) |
| 정확도 | 영어·중국어는 Whisper large-v3보다 우수(CommonVoice-en WER 7.39 vs 9.90, WenetSpeech meeting 5.88 vs 19.11). **다국어 Fleurs 평균은 Whisper가 우수**(8.16 vs 12.60) | HF 모델 카드 |

## 3. 핵심 설계 결정

### 3.1 타임스탬프 전략: VAD 분할 + 엔진별 정밀화

자막 앱에서 타임스탬프는 필수인데, Qwen은 정렬기 없이는 시간을 주지 않고 정렬기는 11개 언어만 지원한다. 따라서 다음 구조로 간다.

1. **VAD로 발화 구간을 먼저 자른다.** faster-whisper에 포함된 Silero VAD(`faster_whisper.vad.get_speech_timestamps`)는 CTranslate2 모델 없이 onnxruntime으로 동작하므로, 새 의존성 없이 재사용한다. 파라미터는 현재 Whisper 호출과 같게 맞춘다(`max_speech_duration_s=15`, `min_silence_duration_ms=200`, `speech_pad_ms=300`, `threshold=0.3`).
2. **각 VAD 구간을 Qwen3-ASR로 전사한다.** 구간 길이가 15초 이하이므로 패키지의 자체 분할에 의존하지 않는다.
3. **정렬기 지원 언어(11개)**: 구간별로 ForcedAligner를 돌려 단어·문자 타임스탬프를 얻고, `subtitle_segmenter`(§3.4)가 이를 자막 큐로 묶는다.
4. **정렬기 미지원 언어에서는 Qwen을 쓰지 않는다 (결정됨, 2026-11-10).** 15초짜리 큐는 자막으로 쓰기 어려우므로 품질을 낮춰 진행하지 않고 막는다.
   - **언어를 지정한 경우**: Qwen 엔진 프리셋에서는 언어 선택지를 정렬기 지원 11개와 "자동 감지"로 제한한다. 이미 저장된 프리셋이 미지원 언어를 가리키면 작업 시작 전에 거부한다(`start_stt`와 Python 양쪽에서 검사).
   - **자동 감지인 경우**: 첫 VAD 구간들의 전사 결과로 언어를 판정하고, 미지원 언어이면 그 시점에 작업을 중단한다. 오류 코드는 `stt_language_unsupported_by_engine`이고, 이미 처리한 구간은 버린다. 첫 구간에서 바로 판정하므로 낭비되는 시간은 짧다.
   - **사용자 안내 (i18n)**: "Qwen3-ASR은 이 언어의 자막 타이밍을 정확히 맞출 수 없습니다. 이 언어는 Whisper 모델로 전사해 주세요." 프리셋 화면의 Qwen 모델 설명에도 지원 언어 11개를 표시한다.
   - Whisper로 자동 전환(폴백)하지 않는다. Whisper 모델이 설치되어 있지 않을 수 있고, 사용자가 고른 엔진이 몰래 바뀌는 것보다 이유를 알려 주는 편이 명확하다.

이 구조의 부수 효과로 Whisper 경로와 같은 VAD 파라미터를 쓰게 되어, 두 엔진의 큐 길이 특성이 비슷해진다.

### 3.2 Python 엔진 추상화

현재 `stt_engine.py`는 모듈 전역 `_model`과 faster-whisper 호출 시그니처에 묶여 있다. 오케스트레이션과 백엔드를 분리한다.

- **유지 (엔진 무관)**: 작업 상태, 취소 플래그, 60분 초과 30분 청크 분할(`_compute_chunks`), ffmpeg 추출과 `dynaudnorm` 부스트, `_dominant_language`, SSE 이벤트 형태(`stt_segment` / `stt_progress` / `done`).
- **인터페이스** `stt_backends.py` (P1에서 구현):
  ```python
  class SttBackend(Protocol):
      engine_id: str        # "faster-whisper" | "qwen3-asr"
      display_name: str     # 진행·오류 메시지용 ("Whisper")
      def find_model(self, model_dir: Path, model_id: str) -> Path | None: ...  # 엔진별 필수 파일 검사
      def check_available(self) -> None: ...   # 런타임 import 실패 시 실제 이유로 RuntimeError
      def load(self, model_path: Path) -> None: ...
      def unload(self) -> None: ...
      def transcribe(self, audio_path: str, language: str | None
                     ) -> tuple[Iterator[SttSegment], SttInfo]: ...
  ```
  `transcribe`는 지금의 faster-whisper와 같은 `(지연 세그먼트 이터레이터, info)`를 돌려준다. 오케스트레이터가 세그먼트를 하나씩 꺼내며 취소 플래그를 확인하고, `info.language`는 이터레이터를 다 소비한 뒤에 읽는다. 그래서 Qwen처럼 디코딩 중에 언어를 알게 되는 엔진도 나중에 채워 넣을 수 있다.
- **모듈은 평면 구조**: 앱 번들 글롭(`resources/python-server/*`)과 `sync-python-resources.mjs`가 하위 폴더를 전제하지 않으므로 패키지 대신 `stt_backends.py`(계약·레지스트리) + `stt_backend_whisper.py` + (P4) `stt_backend_qwen.py`로 둔다.
- `stt_backend_whisper.py`: 기존 코드를 옮겼다(동작 변경 없음). 디코딩 설정은 `TRANSCRIBE_KWARGS`로 모아 테스트로 고정했다.
- `stt_backend_qwen.py`(P4에서 구현): §3.1 흐름을 구현한다. torch·qwen_asr는 엔진 팩에 있으므로 **모듈 import 시점이 아니라 `check_available()`에서 지연 import**하며, 팩 미설치나 DLL 로드 실패는 실제 이유를 담은 `RuntimeError`로 보고한다(기존 가드 규약의 취지와 동일). 언어는 첫 ~20초 분량 발화의 투표로 정하고, 다른 지원 언어로 전환된 구간은 그 언어로 정렬한다. 미지원 언어 오류는 `stt_language_unsupported_by_engine:` 접두로 시작한다. `load(model_path, aux_paths)`가 `{"aligner": 경로}`를 받는다.
- `run_stt`의 기본 모델 탐색과 `load_model`은 이미 `backend.find_model`을 쓴다(P1). P4에서 요청의 `engine` 값을 넘기기만 하면 된다.

### 3.3 카탈로그·Rust: 이름은 유지하고 `engine` 필드 추가

`whisper_models` / `Preset.whisper_model` / `active_whisper_model` / `model_type: "whisper"`는 Rust·프론트·저장된 사용자 설정에 퍼져 있다. 이름을 바꾸면 설정 마이그레이션이 필요하므로 **v1에서는 이름을 유지하고 의미를 "STT 모델"로 넓힌다.** `docs/glossary.md`에 그 의미를 기록한다.

`WhisperCatalogEntry`에 추가할 필드 (모두 `#[serde(default)]`):

| 필드 | 타입 | 기본값 | 용도 |
|---|---|---|---|
| `engine` | `"faster-whisper" \| "qwen3-asr"` | `"faster-whisper"` | Python 백엔드 선택 |
| `requires` | `Vec<String>` | `[]` | 함께 받아야 할 보조 모델 id (예: 정렬기) |
| `role` | `"stt" \| "aligner"` | `"stt"` | `aligner`는 선택 목록에서 숨김 |
| `languages` | `Option<Vec<String>>` | `None` (= Whisper 전체) | UI 언어 필터, 정밀도 경고 |
| `min_vram_mb` | `Option<u32>` | `None` | 적합도 표시, GPU 요구 |

- 기존 `files[]` + 파일별 `sha256` 맵 구조가 샤드 safetensors에 그대로 맞는다. **Qwen 항목은 모든 파일을 LFS OID로 고정한다.** 현재 Whisper 항목은 `model.bin`만 고정하는데, 이 부분은 별도 개선 대상이다.
- `download_model`은 `requires`를 먼저 내려받는다. `verify_model`(commands_model.rs:318)은 `model.bin` 하드코딩 대신 `sha256` 맵의 모든 파일을 검증한다.
- `start_stt`는 Python 요청 본문에 `engine`과 `aux_models: {"aligner": "<id>"}`를 추가로 싣는다. `SttStartRequest`에 같은 필드를 추가하고, 기본값은 `engine="faster-whisper"`로 한다. 이벤트 형태가 바뀌지 않으므로 `sse_client.rs`와 `usePipeline.ts`는 수정하지 않는다.
- 매니페스트의 `model_type`은 계속 `"whisper"`로 둔다(STT 의미). 정렬기도 `"whisper"` + `role: aligner`로 기록해, 프리셋 선택 목록에서만 걸러낸다.

### 3.4 `subtitle_segmenter.py` (신규, 순수 함수)

정렬기 출력(`text`, `start_time`, `end_time`의 목록)을 자막 큐로 묶는다.

- 분할 기준: 문장부호(`.?!。？！…`), 단어 간 공백 ≥ 0.6초, 큐 최대 길이 7초, 최대 42자(중국어·일본어 24자, 한국어 32자). 상수는 모듈 상단에 둔다. 실제 녹음에서 한국어에 24자를 적용하면 문장 중간("시험해 / 보겠습니다")에서 끊겨 한글은 별도 기준으로 분리했다.
- 텍스트 재구성: 정렬기 토큰을 그대로 이으면 공백과 문장부호가 사라지므로, ASR 원문 텍스트에 토큰을 순서대로 대응시켜 원문 구간을 잘라 쓴다.
- 입력과 출력만 있는 순수 함수라서 모델 없이 pytest로 고정할 수 있다.

### 3.5 의존성: 필요할 때만 설치하는 "엔진 팩"

torch CUDA 휠만 ~2.5GB라서 기본 설치에 넣으면 모든 사용자의 첫 설치가 몇 배로 커진다. 그래서 **Qwen 모델을 처음 내려받을 때 자동으로 함께 설치**한다. 사용자에게는 모델 다운로드의 일부로만 보인다(§1 제0원칙).

- `python-server/requirements-qwen.lock` (P3에서 구현): `scripts/lock_python.py qwen`으로 생성한다. `requirements-qwen.txt`(torch 2.8.0+cu126, transformers 4.57.6, accelerate 1.12.0, nagisa, soynlp, librosa)를 기본 lock을 constraints로 해석하고, **기본 lock에 있는 패키지를 전부 뺀다.** `qwen-asr`는 `--no-deps`로 추가한다(gradio·flask·sox·qwen-omni-utils·pytz·vllm 제외). 결과 23개 패키지, 모두 SHA-256 고정. torch 인덱스 줄은 lock 안에 둔다.
- **설치 위치 (설계 변경)**: 처음 안은 기본 `env_dir`에 같이 설치하는 것이었으나, `%APPDATA%/LocalSub/engine-packs/qwen3-asr/`에 따로 둔다. `.partial`에 설치한 뒤 이름을 바꿔 넣으므로 업데이트·재설치가 원자적이고, 반쯤 설치된 팩이 기본 환경에 섞이지 않는다. 기본 lock과 겹치는 패키지가 없고, 서버가 팩을 `sys.path` 맨 뒤에 붙이므로 한 프로세스에 두 버전이 보이는 일은 없다.
- 기본 lock의 `tokenizers`를 0.22.2로, `huggingface_hub`를 0.36.2로 `requirements.txt`에 고정했다(§10.3). 다른 패키지는 기존 lock 버전을 그대로 유지했다(httpx·typer·rich 등 1.x hub 전용 의존성만 빠지고 requests·urllib3·charset_normalizer가 들어옴).
- 설치 상태는 팩 폴더의 `.complete` 마커에 **기본 lock + 팩 lock** 해시로 기록한다. 둘 중 하나가 바뀌면 `Stale`이 되어 재설치한다.
- 서버는 시작 시 팩을 import하지 않는다. Qwen 백엔드가 로드될 때 `engine_packs.activate("qwen3-asr")`가 경로를 붙이므로, 서버 실행 중에 팩을 설치해도 재시작이 필요 없다.
- Tauri 명령 `get_engine_pack_status` / `install_engine_pack("qwen3-asr")`: `engine-pack-progress` 이벤트(`installing` / `done` / `failed` + `error_kind`)와 10GB 디스크 여유 검사를 포함한다. 설치 후 팩 ~6.7GB(내려받는 양은 ~3GB)에 모델(1.7B 4.4GB / 0.6B 1.8GB)과 정렬기 1.8GB가 더해진다(§10.4).
- CLAUDE.md §8 공급망 정책을 그대로 따르고, 정책 문서에 엔진 팩 항목을 추가한다.

### 3.6 GPU와 VRAM

- **v1은 NVIDIA GPU 전용.** `nvidia-smi` 감지에 실패하거나 `min_vram_mb`에 못 미치면 Qwen 모델은 "GPU 필요"로 비활성화한다. torch CPU 추론은 휠 크기와 속도 양쪽에서 이점이 없다.
- `CUDA_VISIBLE_DEVICES=<UUID>` 고정(`gpu.rs`)은 torch에도 그대로 적용된다.
- STT → 번역 전환 시 서버 재시작으로 VRAM을 회수하는 기존 방식(`usePipeline.ts` `chainTranslation`)을 그대로 쓴다. torch 캐시 할당자가 쥔 메모리도 프로세스 종료로 확실히 풀린다.
- dtype: bf16을 지원하지 않는 GPU(Turing 이하)는 fp16으로 바꾼다. P0은 Ada(RTX 4060 Ti)에서 bf16만 확인했다. fp16 품질은 P4에서 확인한다.
- `min_vram_mb` 기준(P0 실측 + 여유): **1.7B = 8192, 0.6B = 6144**. 8GB 카드에서 1.7B는 여유가 ~1.5GB뿐이므로, P4에서 "전 구간 ASR → ASR 해제 → 정렬" 순서로 바꿔 동시 적재를 피하는 방안을 측정한다.

## 4. 영향 범위

| 영역 | 파일 | 변경 |
|---|---|---|
| Python | `stt_engine.py` | 백엔드 위임 리팩터, 필수 파일 검사 일반화 |
| Python | `stt_backends/{base,whisper,qwen}.py` | 신규 |
| Python | `subtitle_segmenter.py` | 신규 |
| Python | `stt_router.py`, `runtime_router.py` | `engine`·`aux_models` 필드, 로드·언로드 경로 |
| Python | `requirements-qwen.lock` | 신규 |
| Rust | `state.rs` | `WhisperCatalogEntry` 필드 추가 |
| Rust | `commands_model.rs`, `model_downloader.rs` | `requires` 처리, 전체 파일 검증 |
| Rust | `commands_stt.rs` | 요청 본문에 `engine`·`aux_models` 추가 |
| Rust | `setup_manager.rs`, `integrity.rs` | 엔진 팩 설치, 마커, torch 휠 고정 |
| Rust | 신규 명령 `install_engine_pack` | 프론트 노출 |
| 리소스 | `model_catalog.json` | Qwen 2종 + 정렬기 항목 |
| 프론트 | `types.ts`, `ModelsSection.tsx`, `StepModels.tsx`, `PresetsPage.tsx` | 엔진 배지, 팩 설치 흐름, `role: aligner` 숨김, GPU 경고, Qwen 프리셋의 언어 선택지 제한, 미지원 언어 오류 안내 |
| 프론트 | `InfoSection.tsx` | 하드코딩된 "faster-whisper (CTranslate2)" 표기를 엔진별로 |
| i18n | `locales/*.json` (5개) | 새 문자열 |
| CI | `.github/workflows/ci.yml` | qwen lock 동시 검증 |
| 문서 | `CLAUDE.md`, `README*.md`, `docs/glossary.md` | 기술 스택, 카탈로그 규약, 공급망 정책 |

## 5. 테스트 계획

- **pytest**
  - `subtitle_segmenter`: 분할 기준, CJK, 원문 텍스트 재구성, 빈 입력.
  - Qwen 백엔드: 가짜 모델로 VAD 구간 처리, 지정 언어가 미지원이면 시작 전 거부, 자동 감지 결과가 미지원이면 `stt_language_unsupported_by_engine`으로 중단, 취소, 언어 감지 결과 전달.
  - `test_stt_extraction.py`와 `test_stt_language.py`의 기존 테스트가 백엔드 리팩터 후에도 그대로 통과해야 한다(동작 변경 없음 확인).
  - `test_native_import_guards.py`에 `qwen_asr` 행 추가.
  - `test_api_endpoints.py`: `engine` 기본값과 전달.
- **cargo test --lib**
  - `test_bundled_catalog_declares_license_for_every_entry`가 새 항목을 포함하는지.
  - `engine`·`requires` 기본값 역직렬화(기존 카탈로그 호환).
  - `requires` 다운로드 순서, 전체 파일 검증.
  - 엔진 팩 pip 인자(`--require-hashes`, `--no-deps`, constraints), 마커 해시 갱신.
- **Vitest**: aligner 숨김, GPU 미달 비활성화, Qwen 프리셋의 언어 목록이 11개로 제한되는지, 미지원 언어 오류 메시지 표시, 팩 설치 진행 상태.
- **수동**: 실제 GPU에서 한국어·영어·일본어(정렬기 지원)를 전사하고, 태국어(미지원) 샘플은 안내 메시지와 함께 거부되는지 확인한다. 지원 언어의 큐 품질은 Whisper large-v3와 비교한다. VRAM 최대치와 처리 속도를 측정한다.

## 6. 단계별 진행

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **P0 스파이크** ✅ 완료 | 임베디드 CPython 3.12 + Windows + torch cu12 + `qwen-asr` transformers 백엔드로 실제 파일 전사. `--no-deps` 최소 의존성 확인, VRAM과 속도 측정, 정렬기 출력 단위 확인, `faster_whisper.vad` 단독 사용 확인 | 동작 여부와 수치 보고. **실패하면 여기서 중단하거나 §7 대안으로 전환** |
| P1 ✅ 완료 | 백엔드 추상화 리팩터(Whisper만, 동작 변경 없음) | 기존 테스트 전부 통과 |
| P2 ✅ 완료 | 카탈로그 필드, `requires` 다운로드, 전체 파일 검증 (+ 보조 모델 자동 삭제, `start_stt`의 `engine`·`aux_models` 전달) | cargo 테스트, 기존 카탈로그 호환 |
| P3 ✅ 완료 | 엔진 팩 lock과 설치 명령, CI 검증 | 깨끗한 환경에서 설치·재설치 |
| P4 ✅ 완료 | Qwen 백엔드 + `subtitle_segmenter` | pytest, 수동 전사 비교 |
| P5 ✅ 완료 | UI, i18n, 문서 (설정 모델 목록의 엔진 배지·GPU 검사·구성요소 준비 표시, 마법사는 Whisper만, 프리셋 언어 제한, 오류 코드 → 쉬운 안내, 마지막 Qwen 모델 삭제 시 팩 삭제) | Vitest, 실제 앱에서 마법사→작업→번역 전 과정 |

P1과 P2는 서로 독립적이라 병렬로 진행할 수 있다. P4는 P1~P3이 끝나야 시작할 수 있다.

## 7. 검토한 대안

| 대안 | 장점 | 기각·보류 사유 |
|---|---|---|
| sherpa-onnx int8 0.6B (ONNX) | onnxruntime이 이미 의존성에 있음. torch 불필요, Windows 지원, 설치가 가벼움 | 서드파티 변환본이고, 0.6B만 있으며, 타임스탬프 지원이 명시되지 않음. **P0에서 torch 경로가 막히면 1순위 대안** |
| GGUF + llama.cpp | 번역 엔진과 런타임 공유 | 메인라인 llama.cpp 지원이 확인되지 않음. 변환본마다 호환성이 제각각 |
| vLLM | 공식 권장, 가장 빠름 | Windows 네이티브 미지원 |
| torch를 기본 설치에 포함 | 구현 단순 | Qwen을 쓰지 않는 사용자까지 설치 크기가 몇 GB 늘어남 |
| `whisper_*` 명칭을 `stt_*`로 변경 | 의미가 명확 | 저장된 설정·프리셋 마이그레이션 필요. v2에서 검토 |

## 8. 결정 사항 (모두 확정, 2026-11-10)

1. ~~**정렬기 미지원 언어 처리**~~ → **결정: Qwen 사용 금지, 이유 안내** (2026-11-10, §3.1-4).
2. ~~**모델 범위**~~ → **결정: 1.7B와 0.6B 둘 다 등재** (2026-11-10). 0.6B는 VRAM이 작은 GPU용이다.
3. ~~**GPU 전용 정책**~~ → **결정: v1은 NVIDIA 전용** (2026-11-10).
4. ~~**설치 방식**~~ → **결정: 엔진 팩 지연 설치** (2026-11-10, §3.5).

## 9. 작업 중 발견한 별도 문제 (이 설계 범위 밖)

- `setup_manager.rs` `CUDA_RUNTIME_PKGS`(`nvidia-cuda-runtime-cu12`, `nvidia-cublas-cu12`)가 **해시 없이** `pip install`된다. CLAUDE.md §8의 "모든 외부 패키지 SHA-256 검증" 정책과 어긋난다. → **해결됨** (PR #24, `integrity.json`의 `cuda_runtime`에 해시 고정).
- `PresetsPage.tsx:299, 317`의 기본값 `"large-v3"`는 카탈로그에 없는 id다(실제 id는 `whisper-large-v3`). 그래서 Rust가 조용히 활성 모델이나 첫 모델로 대체한다.
- `config.model_dir`를 바꿔도 Python의 `MODEL_DIR`은 항상 `%APPDATA%/LocalSub/models`라서, 사용자 지정 모델 경로가 Python에 전달되지 않는다.
- Whisper 카탈로그 항목은 `model.bin`만 해시로 고정하고, `config.json`·`tokenizer.json` 등은 검증하지 않는다.

## 10. P0 스파이크 결과 (2026-11-10)

**결론: 진행 가능.** Windows + 앱 내장 Python에서 Qwen3-ASR과 정렬기가 동작하고, 속도는 Whisper large-v3와 비슷하며, 8GB 카드에 1.7B까지 올라간다. 걸림돌은 기본 lock과의 버전 충돌 하나이고, 해결책도 검증했다(§10.3).

### 10.1 환경
- Windows 11, RTX 4060 Ti 8GB, 드라이버 610.88
- 앱 번들과 같은 임베디드 CPython 3.12.8, 기본 `requirements.lock`을 해시 검증으로 설치한 `env_dir` 복제본
- 팩: torch 2.8.0+cu126, transformers 4.57.6, accelerate 1.12.0, qwen-asr 0.0.6 (`--no-deps`)
- 흐름: `faster_whisper.vad.get_speech_timestamps`(앱과 같은 파라미터) → 구간별 `Qwen3ASRModel.transcribe(language=None)` → 첫 구간 언어가 정렬기 지원 언어이면 `Qwen3ForcedAligner.align`
- 음성: 한국어·영어는 Windows TTS(46초, 39초), 일본어·태국어는 FLEURS dev 발화를 이어 붙인 것(61초, 65초)

### 10.2 측정값

| 엔진 | 언어 | 감지 | CER | 처리 시간(전사+정렬) | RTF |
|---|---|---|---|---|---|
| Qwen 0.6B | ko | Korean | 0.000 | 4.4 + 0.4초 | 0.104 |
| | en | English | 0.000 | 2.2 + 0.3초 | 0.066 |
| | ja | Japanese | 0.139 | 4.8 + 0.5초 | 0.087 |
| | th | Thai (정렬 안 함) | 0.024 | 7.0초 | 0.107 |
| Qwen 1.7B | ko | Korean | 0.000 | 4.5 + 0.4초 | 0.105 |
| | en | English | 0.000 | 2.3 + 0.3초 | 0.068 |
| | ja | Japanese | 0.091 | 4.9 + 0.4초 | 0.086 |
| | th | Thai (정렬 안 함) | 0.087 | 7.1초 | 0.109 |
| Whisper large-v3 (앱 설정) | ko | ko | 0.016 | 4.8초 | 0.105 |
| | en | en | 0.000 | 2.6초 | 0.067 |
| | ja | ja | 0.298 | 3.3초 | 0.054 |
| | th | th | 0.017 | 9.1초 | 0.139 |

- **VRAM**(프로세스 증가분): 0.6B 1.8GB + 정렬기 1.5GB, 최대 **4.0GB**. 1.7B 4.5GB + 정렬기 1.3GB, 최대 **6.5GB**.
- **적재 시간**: 0.6B 2.4초, 1.7B 4.4초, 정렬기 2.5초.
- **정렬 출력**: 단어별 `(text, start, end)`, 초 단위, 입력 구간 기준. 예: 한국어 `오늘 1.80–2.04, 은 2.04–2.28, 로컬 2.28–2.68`. 자막 큐로 묶기에 충분하다.
- **VAD 단독 사용**: `faster_whisper.vad`는 CTranslate2 모델 없이 동작했다(구간 분할 0.1~0.4초).
- **언어 감지**: 4개 언어 모두 첫 구간부터 정확히 감지했다. 태국어는 정렬기 미지원으로 판정되므로 §3.1-4의 거부 경로가 첫 구간에서 바로 동작할 수 있다.
- 한계: 샘플이 짧고 한국어·영어는 TTS라 쉬운 편이다. CER은 경향만 보는 값이다. 실제 녹음(잡음, 여러 화자, 긴 파일) 비교는 P4 수동 테스트에서 한다.

### 10.3 버전 충돌과 해결
- `transformers 4.57.6`이 import 시점에 `tokenizers>=0.22,<=0.23.0`을 검사해 실패한다. 기본 lock은 `tokenizers 0.23.1`, `huggingface_hub 1.19.0`이다(0.23.0은 PyPI에 없음).
- **검증한 해결책**: `tokenizers 0.22.2` + `huggingface_hub 0.36.2`를 우선 경로에 두고 (1) Python 서버 테스트 전체(159 통과, 1 skip)와 (2) faster-whisper large-v3 실제 GPU 전사(위 표의 Whisper 행)를 실행했다. 둘 다 정상이다.
- **권장**: 기본 `requirements.txt`/`requirements.lock`에서 두 패키지를 위 버전으로 고정한다(P3). 사용자 입장에서는 앱 업데이트 후 첫 실행 때 자동 재설치(`setup_inputs_hash` 변경)만 일어나고, 고를 것은 없다(§1 제0원칙). 팩만 다른 버전을 쓰게 하는 경로 분리 방식은 한 프로세스에 두 버전이 섞일 위험이 있어 택하지 않는다.

### 10.4 엔진 팩 최소 구성 (`--no-deps` 기준, 기본 lock에 없는 것만)
- 필수: `torch`, `transformers`, `accelerate`, `qwen-asr`, `safetensors`, `regex`, `requests`(+`urllib3`, `charset_normalizer`), `sympy`, `mpmath`, `networkx`
- 정렬기 언어 처리: `nagisa 0.2.11`(일본어, cp312 win_amd64 휠 있음) + `dyNET38 2.2`, `soynlp 0.0.493`(한국어)
- `qwen_asr.inference.utils`가 최상위에서 import: `librosa 1.0.0` + `numba`, `llvmlite`, `soxr`, `lazy-loader`, `decorator`, `msgpack`, `pooch`, `platformdirs`, `six`
- **불필요(설치 안 함)**: gradio, flask, sox, qwen-omni-utils, pytz, vllm
- 디스크: 설치 후 팩 **~6.7GB**(대부분 torch의 CUDA 라이브러리) + 모델(0.6B 1.8GB / 1.7B 4.4GB) + 정렬기 1.8GB. 설치 전 여유 공간 안내 기준은 **1.7B 기준 ~14GB**.
- `Cython`, `dyNET38`가 nagisa 런타임에 실제로 필요한지는 P3에서 하나씩 빼 보며 확인한다.

### 10.5 구현 시 주의
- 콘솔 코드페이지가 cp949라 일본어·태국어 텍스트를 stdout에 쓰면 `UnicodeEncodeError`가 난다. 서버는 stdout을 버리지만, 로그·디버그 출력은 UTF-8로 고정한다(`-X utf8` 또는 `PYTHONUTF8=1`).
- `max_new_tokens`는 15초 구간 기준 256이면 충분했다.
- 생성 시 `temperature` 무효 경고, transformers FutureWarning이 나온다. 동작에는 영향 없음.

## 출처

- https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- https://huggingface.co/Qwen/Qwen3-ASR-0.6B
- https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B
- https://github.com/QwenLM/Qwen3-ASR
- https://pypi.org/project/qwen-asr/
- https://arxiv.org/abs/2601.21337
- https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html
