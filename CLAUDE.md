# LocalSub — AI Subtitle Generator & Translator

100% 로컬 AI 기반 자막 생성 및 번역 데스크톱 앱.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Tailwind CSS v4 + Radix UI
- **Desktop**: Tauri 2 (Rust) — IPC, 파일 I/O, 프로세스 관리
- **AI Engine**: Python FastAPI (port 9111)
  - STT: faster-whisper (CTranslate2). VAD는 faster-whisper 내장 Silero (`vad_filter=True`)
  - Translation: llama-cpp-python (GGUF models)
  - Diarization: ONNX Runtime 임베딩 + scikit-learn 응집 군집화 (VAD 아님)
- **Build**: Vite + Cargo
- **Tests**: Vitest (프론트) / pytest (python-server) / `cargo test --lib` (Rust)

## Architecture

```
React UI ←→ Tauri IPC ←→ Rust Backend ←→ HTTP(9111) ←→ Python FastAPI
                                                            ↓
                                                     AI Models (GPU/CPU)
```

VRAM 관리: 번역 시작 전 **Python 서버를 통째로 재시작**해 Whisper VRAM을 회수한다 (`usePipeline.ts`).
`unload_runtime_model`이 있지만 CTranslate2 Whisper 언로드가 Windows에서 세그폴트해 쓰지 않는다.
`restart_server`는 nvidia-smi 가용 VRAM이 6GB를 넘을 때까지 최대 20초 대기 후 재spawn.

## Development

```bash
# Prerequisites: Node.js, Rust, Python 3.10+, CUDA toolkit
npm install
pip install -r python-server/requirements.txt   # or requirements.lock (hash-pinned)
# llama-cpp-python: prebuilt wheel, NO source build (CUDA index shown; whl/cpu for CPU)
pip install llama-cpp-python==0.3.28 --only-binary llama-cpp-python \
  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# Dev mode
npm run tauri dev
# Windows: 반드시 vcvarsall.bat으로 초기화된 셸에서 실행할 것 — cargo가 MSVC
# link.exe와 LIB 경로를 그 환경에서 찾는다. 로컬 래퍼 run-dev.bat을 쓸 수 있으나
# gitignore 대상이라 저장소에는 없다.
# ⚠️ src-tauri/.cargo/config.toml에 링커/라이브러리 절대경로를 커밋하지 말 것.
# 머신마다 VS 에디션·Windows SDK 버전이 달라 남의 빌드를 깨뜨린다(.gitignore 대상).

# Tests
npm test                                  # vitest
cd src-tauri && cargo test --lib          # `--lib` 필수 (bin 타깃엔 테스트 없음)
cd python-server && python -m pytest -q . # 경로 `.` 필수 (아래 주의 참조)
```

⚠️ `pytest`에 **경로 인자 `.`을 반드시 줄 것.** 생략하면 rootdir을 위로 거슬러 탐색해
상위 디렉토리의 무관한 테스트를 수집한다(`Labs/` 형제 프로젝트까지 끌어와 200+ collection error).
pytest 버전에 따라서는 경로의 `[]`(`[projects] localsub`) 때문에
`path cannot contain [] parametrization`으로 죽기도 한다. CI도 `pytest -q .` 형태를 쓴다.

## Key Directories

```
src/                  # React frontend
src-tauri/src/        # Rust backend (Tauri commands)
python-server/        # FastAPI AI inference server
  stt_engine.py       # STT (faster-whisper, 60분+ 파일은 30분 청크 분할)
  llm_engine.py       # LLM translation (세그먼트 단위, rolling summary, 품질 게이트)
  prompt_builder.py   # Translation prompt construction
  quality_filters.py  # 구조적 비-번역 탐지 (스크립트/길이/반복) — 모델 무관
  embedding_gate.py   # 의미적 게이트 (타겟 언어로 쓰인 거부문 탐지)
  translate_router.py # Translation API endpoints
```

Python 서버는 `/health` + 라우터 4개(`/stt` `/translate` `/diarization` `/runtime`)만 노출한다.
잡 계열은 모두 `POST .../start` → `GET .../stream/{job_id}`(SSE) → `POST .../cancel/{job_id}` 패턴.
취소는 협조적 플래그 폴링. (스캐폴딩이던 `/inference/*` 목업은 제거됨)

## Model Catalog

`src-tauri/resources/model_catalog.json` — 모델 목록 관리.
Whisper 모델은 `model.bin` + `config.json` + `tokenizer.json` + `vocabulary.*` 필요 (tiny~medium은 이 4파일뿐).
⚠️ Whisper large-v3와 kotoba-whisper-v2는 `preprocessor_config.json`도 필수 — large-v3는 이게 있어야 128 mel channels 사용.

LLM 모델 등재 기준:
- `model_category`: `"general"`은 프롬프트에 `/no_think` 주입(Qwen3 전용 디렉티브) → **비-Qwen3 모델(Gemma·Qwen2.5 등)은 반드시 `"instruct"`** (잡토큰 방지). `prompt_builder.py` 참조.
  - 카탈로그에 없는 모델의 `model_category` 폴백은 `"instruct"`. `/no_think`는 opt-in이어야 하므로 기본값이 `"general"`이면 안 된다 (`commands_translate.rs`, `prompt_builder.py` 양쪽).
- 라이선스: 카탈로그 등재 = 다운로드 링크 제공이므로 **재배포 가능 라이선스만**(Apache/MIT/Gemma OK). 제외 대상: NC(EXAONE 등), 영토 제외 조항(Tencent Hunyuan = 대한민국 명시 제외), CC-BY-NC 의심(Tower+).
- `sha256`은 HuggingFace LFS oid로 채움(모델 다운로드 없이 API에서 취득). 분할 모델은 `split_files`.

## Translation Pipeline

1. STT (Whisper) → segments with timestamps
2. Whisper 해제 (VRAM) — 실제로는 서버 재시작. 위 Architecture 참조
3. Auto-infer media context (첫 100 세그먼트로 장면/장르 추론)
4. LLM 로드 → **세그먼트 단위** 번역 (배치 없음)
5. 각 세그먼트마다 품질 게이트 → 걸리면 높은 temperature로 1회 재시도 + 플래그
6. 25개마다 rolling summary 생성 (200개마다 처음부터 재생성해 드리프트 방지)
7. 프롬프트: 심플하게 유지 (9B 모델에 복잡한 프롬프트는 역효과)

품질 게이트 순서 (`llm_engine.py`의 `_bad_output_reason`):
`_looks_like_refusal`(구문, 모델별로 취약) → `quality_filters`(구조적: 스크립트 누출·off-target
언어·길이 폭증·퇴행 반복) → `embedding_gate`(의미적, 마지막). 구조적 신호가 주력이다 —
거부 문구는 생성마다·모델마다 달라서 구문 목록은 항상 불완전하다.
임베딩 게이트는 `LOCALSUB_DISABLE_EMBED_GATE`(비어있지 않은 아무 값)로 끄고, 모델(~250MB)이 없으면 조용히 no-op.

⚠️ `translation_mode`는 **두 곳에서 다른 의미**다.
`config.translation_mode` = `"local"` / `"off"` (번역 자체를 끄는 스위치),
`preset.translation_mode` = `"direct"` / `"pivot_2pass"` (Python으로 전달되는 번역 전략).

## Git History

이 저장소는 2026-07-10에 **단일 초기 커밋으로 다시 시작**했다. `git log`·`git blame`·`git bisect`가
그 이전을 못 보고, 그 이전의 커밋 SHA·이슈·PR 번호는 이 저장소에서 해석되지 않는다.

교훈 하나는 남긴다: **검증 없이 지어낸 값을 박지 말 것.** URL·핸들·경로는 박기 전에 실제로 쳐볼 것.
같은 부류로 `api_key`·`provider` 죽은 config 필드와, 그걸 근거로 없는 기능을 광고하던 README의
"외부 API 연동"이 있었다(문서는 정정됨; 필드 자체는 `state.rs`에 아직 남아 있고 어디서도 읽히지
않는다 — 제거는 별도 PR로).

## Important Notes

- Python 서버는 앱 시작 시 자동 시작. `commands_runtime.rs`의 3초 폴링이 10회 연속 실패하면 `server-crashed`를 emit하고, `usePipeline.ts`가 활성 파이프라인을 전부 `failed`로 표시한다. **Rust에는 자동 재시작이 없고**, 프론트의 `useServerStatus.ts`가 `server-crashed` 수신 3초 뒤 상태가 여전히 ERROR/STOPPED면 `startServer()`를 자동 호출한다(파이프라인의 의도적 재시작 — 모델 스왑 — 과는 상태 가드로 경합 회피).
- STT/번역 시작 전 서버 health 체크 (최대 30회 대기)
- 프리셋의 모델·언어·스타일·용어집은 번역에 반영됨 (`commands_translate.rs`: `preset.llm_model`/`source_lang`/`translation_style`/`vocabulary_id`가 config보다 우선, 미설정 시 config 폴백). 과거의 "프리셋 미반영 TODO"는 해소됨.
- ⚠️ **`state.app_config`는 지연 로딩**된다(첫 config 명령이 채운다). config가 필요한 명령은 **`config_manager::ensure_loaded(&mut s)`로 그때그때 로드**할 것 — 예전엔 모델 명령들이 `app_config`가 이미 Some이길 *요구*하고 아니면 "Config not loaded"로 죽었다. 프론트가 마운트 시 `getConfig`와 `getModelManifest`를 **동시에** 쏘고 Tauri는 명령을 병렬 실행하므로, `get_model_manifest`가 레이스에서 이기면 에러 → `loadManifest`가 재시도 없이 `manifest`를 []로 남길 수 있다. `ensure_loaded`가 이 순서 의존을 없앤다(잠재 레이스 방어).
  - 📌 **주의:** 이 lazy-load는 잠재 레이스 **방어**다. "모델 전부 미설치"로 보이는 증상의 실제 원인은 거의 항상 모델이 디스크에 없는 것이고, 이 레이스가 실측에서 발동한 기록은 없다. 증상을 레이스 탓으로 돌리기 전에 매니페스트와 디스크부터 확인할 것.
- **공급망 무결성** (`src-tauri/src/integrity.rs` + `resources/integrity.json`): 첫 실행이 받는 모든 바이너리를 sha256 검증.
  - Python 패키지: `requirements.lock`(전체 폐포 해시 핀, cp312/win_amd64)을 `pip install --require-hashes`로 설치. `requirements.txt`는 사람이 읽는 정확-버전 핀(`==`).
  - `llama-cpp-python`: **prebuilt 휠을 직접 다운로드 → sha256 검증 → 로컬 `pip install --no-deps`** (의존성은 lock에서 이미 해시 설치). `nvidia-smi`로 GPU 감지 → CUDA 휠 시도, 실패 시 CPU 휠 폴백. 소스 빌드 안 함. 버전은 백엔드별로 다르다 — **CUDA 0.3.31-cu124 / CPU 0.3.28**. 정본은 `integrity.json`.
  - ffmpeg: **gyan(GyanD/codexffmpeg) 버전 태그** zip 다운로드 → sha256 검증 (`latest`·날짜 스냅샷 태그 금지). 현재 태그 `8.1.2`의 essentials 빌드(`ffmpeg-8.1.2-essentials_build.zip`).
    - **첫 실행 셋업이 설치한다**(`ensure_ffmpeg`). PATH/앱 로컬에 이미 있으면 건너뛴다. **non-fatal** — 60분 미만은 PyAV가 디코딩하므로 실패해도 셋업을 죽이지 않는다(마커 저장 전, 마커 불변식과 무관). 예전엔 **미리보기 패널을 열어야만** 설치 버튼이 보여서, 그걸 안 쓰는 사용자는 60분+ 영상이 **청킹 없이 조용히** 처리됐다. `_probe_duration()`이 `None`을 반환하면 이제 `log.error`로 크게 남긴다.
    - ⚠️ **ffmpeg에는 `mirror_url`을 두지 말 것.** 모든 Windows ffmpeg 빌드는 GPLv3이고, GPL 의무는 `convey`(전달)에 붙는다. 제3자 URL만 가리키면 바이트가 그쪽 서버 → 사용자로 흐르므로 전달자가 아니지만, **미러를 두는 순간 배포자가 된다** — 그리고 남이 빌드한 바이너리는 "corresponds exactly"한 Corresponding Source를 입증할 수 없다. 예전에 BtbN 빌드를 미러링하며 이 의무를 미이행하고 있었다.
    - 그래서 `FfmpegEntry`에는 `mirror_url` 필드가 **없고** `deny_unknown_fields`가 걸려 있다. JSON에 되살리면 조용히 무시되는 대신 파싱이 실패한다. `bundled_ffmpeg_is_not_self_hosted`·`ffmpeg_entry_rejects_a_mirror_url`이 지킨다.
    - BtbN을 떠난 이유: 날짜 태그(`autobuild-*`)를 ~1개월 뒤 삭제한다. **해시 핀 + BtbN = 미러 필연.** gyan은 버전 태그를 2021년까지 보존한다.
  - llama_cpp 휠(MIT)만 `mirror_url`(`vendor-assets-v1` 릴리스, 바이트 동일) 폴백을 갖는다 — 재호스팅에 소스 제공 의무가 없다. 검증 불일치 시 `SetupErrorKind::Integrity`.
  - ⚠️ `LlamaWheel::urls()`는 `[url, mirror_url]` 순으로 시도하므로 **`mirror_url`이 upstream과 같으면 폴백이 무의미**하다(죽은 URL을 두 번 침). CUDA 휠이 실제로 그 상태였다. `integrity.rs`의 `llama_cpp_mirrors_are_real_fallbacks`가 번들 JSON을 직접 검사해 재발을 막는다.
  - **빌드 타임 자산도 같은 규칙**(`scripts/download-python-embed.ps1`): 임베더블 CPython과 `get-pip.py`는 설치파일에 그대로 실리므로 sha256 핀 후 검증하고, 불일치면 중단한다(검증은 `resources/`로 옮기기 **전**에 한다). `get-pip.py`는 롤링 URL(`bootstrap.pypa.io`)이 아니라 **`pypa/get-pip`의 커밋 SHA raw URL**에서 받는다 — 롤링 URL은 핀이 불가능하고 실제로 바이트가 바뀌었다. 재호스팅은 하지 않으므로 라이선스 의무는 발생하지 않는다.
  - `resources/python-server`에 무엇이 실리는지는 **`sync-python-resources.mjs` 한 곳만** 정한다(대상 디렉토리를 비우고 `test_*` 제외). `beforeBuildCommand`도 이걸 부른다. 예전엔 ps1이 `*.py`를 전부 복사해 테스트 파일이 번들에 섞였다.
  - **개발자 로컬 경로 유출 가드**(`scripts/check-no-local-paths.mjs`): `npm run build`가 `sync-python` 직후 이걸 돌려 `resources/`·`python-server/`에서 `C:\Users\…`·`/home/…`·`/Users/…`를 찾으면 빌드를 중단한다. 앱이 실행될 때마다 `patch_pth_file`이 `python312._pth`에 `%APPDATA%` 절대경로를 써넣으므로, **dev 실행 직후 릴리스를 빌드하면 개발자 계정명이 공개 설치파일에 박힌다** — 실제로 검증 중에 한 번 그 상태로 빌드 직전까지 갔다. `_pth`는 gitignore라 CI로는 못 잡는다. 로컬 빌드 가드가 본체고 CI 스텝은 커밋된 파일용 2선이다. `src/__tests__/localPathGuard.test.ts`가 가드 자체를 지킨다.
- 첫 실행 셋업 불변식 (전부 실제로 겪은 버그다):
  - 완료 마커는 **모든 설치(llama-cpp 포함) 성공 후 맨 마지막에** 저장. `is_setup_complete`가 마커+해시만 검사하므로, 일찍 저장하면 부분 설치가 '완료'로 위장돼 재시작 후 영구히 깨진다.
  - ⚠️ 마커 해시는 **`requirements.lock` + `integrity.json`을 함께** 해시한다(`setup_inputs_hash`). llama-cpp 휠과 CUDA 런타임은 lock 밖에서(`--no-deps`) 설치되고 핀은 `integrity.json`에 있으므로, lock만 해시하면 **휠을 올려도 셋업이 재실행되지 않아 새 휠이 기존 설치에 영원히 도달하지 못한다.** 휠은 GPU/드라이버/CPU-ISA 크래시를 고칠 때 올리는 바로 그 물건이다.
  - ⚠️ **llama-cpp 휠 설치에는 `--upgrade`를 쓰지 말 것.** 이 휠은 최상위 `bin/`·`lib/`·`include/`를 담고 있고, 그 `bin/`이 python-env의 `bin/pip.exe`와 충돌한다. 셋업은 pip을 `env\bin\pip.exe`로 실행하는데, `--upgrade`가 붙으면 pip의 `_handle_target_dir`이 그 `bin`을 `rmtree`하려 한다 — **pip.exe 자기 자신이 그 디렉터리에서 돌고 있어** sharing violation으로 매번 실패한다(`bin`이 알파벳순 먼저라 llama_cpp를 쓰기도 전에 중단). GPU 실측에서 업그레이드가 3연속 실패한 실제 버그다. `--upgrade` 없으면 pip은 이미 있는 `bin/lib/include`를 경고만 내고 **건너뛴다**(중복본이라 무해 — llama-cpp는 `llama_cpp/lib/`에서 DLL을 로드하지 그 최상위 사본을 안 쓴다). 교체는 `--upgrade`가 아니라 **`purge_installed_llama`**가 한다: 옛 `llama_cpp`+모든 `llama_cpp_python-*.dist-info`를 먼저 지워 새 휠이 빈 자리에 설치되게 한다(그래서 "핀을 올려도 기존 설치에 반영되지 않음" 문제가 해소된다). `0.3.28`·`0.3.31` dist-info 공존이 실제로 있었다. purge의 `remove_dir_all`은 AV 실시간 스캔이 900MB CUDA DLL을 잠깐 잠글 수 있어 **재시도 백오프**를 건다. `wheel_install_does_not_use_upgrade`·`purge_removes_package_and_every_stale_dist_info`가 지킨다. (CUDA 런타임 `nvidia-*` 휠은 최상위가 `nvidia/`라 충돌 없음 → 거기는 `--upgrade` 유지.)
  - 셋업이 고른 백엔드(`cuda`/`cpu`)와 `cuda_selftest` 결과는 로그로 남긴다(백엔드·셀프테스트 성공은 `log::info`, 셀프테스트 실패는 `log::warn`). 진행 상황은 프론트엔드 이벤트로만 흘러서, 이게 없으면 사용자가 CPU 휠로 떨어졌는지 **사후에 알 방법이 없다**.
  - `patch_pth_file`이 번들 리소스(`python312._pth`)에 **쓰기**를 하므로 NSIS `installMode=currentUser` 필수. perMachine(Program Files)이면 ACL 거부로 셋업 실패.
  - 셋업 ERROR 화면은 retry + "초기화 후 재설치"(`reset_setup` → python-env 통째 삭제) 제공. 막혔을 때의 탈출구다.
- **첫 실행 E2E**: `scripts/first-run-e2e.ps1` (`-Backend cpu|cuda`)가 번들 임베드 Python으로 프로비저닝 전체를 격리 재현(get-pip → lock → 휠 → ffmpeg → 서버 `/health`). 시스템 Python/`%APPDATA%` 미접촉.
- **CI** (`.github/workflows/ci.yml`): `push`는 `master`/`feature/*`에서만, `pull_request`는 **master를 향하는 모든 PR**에서 돈다(브랜치 이름 무관). 그래서 `feature/*` PR은 두 트리거가 겹쳐 체크가 두 번씩 뜬다. 잡 3개 — `check`(tsc+vitest+`vite build`) / `lockfile`(`requirements.lock`을 `--require-hashes`로 검증 + drift 가드) / `pytest`.
  - ⚠️ **`cargo test`는 CI에 없다.** Rust 테스트는 로컬에서 `cargo test --lib`로 직접 돌릴 것.
  - `pytest` 잡은 **전체 스위트**를 돌린다(`python -m pytest -q .`). 파일 목록으로 되돌리지 말 것 — 예전 목록 방식이 `test_api_endpoints.py`를 누락시켜 테스트 3개가 썩었고, 그중 하나는 *버그였던 동작을 명세로 고정*하고 있었다.
  - ML 라이브러리는 설치하지 않는다. `faster-whisper`·`llama_cpp`·`onnxruntime`은 optional import라 없어도 엔진 모듈이 import된다. `numpy`만 `diarization_engine`의 하드 의존.
- 번역 glossary는 **vocabulary(프리셋의 `vocabulary_id`) 단일 경로**. 레거시 파일 glossary(`active_glossary`/`save_glossary`/`glossaries/*.json`)는 제거됨. Rust `GlossaryEntry`는 Rust→Python 전송 wire 타입으로만 잔존.
- 모델 선택은 **카탈로그가 아니라 매니페스트**에서 한다 (`commands_translate.rs`: `preset.llm_model` → `config.active_llm_model` → 첫 ready). 카탈로그는 그 뒤에 `n_gpu_layers`·`model_category`를 조회하는 용도라, 카탈로그에서 모델을 빼도 이미 설치된 모델은 계속 선택된다.
- 자기정제 2-pass(`two_pass`)는 제거됨 — 같은 가중치가 두 번째 패스에서도 같은 편향을 낸다. 대체는 `preset.translation_mode = "pivot_2pass"`. config·preset의 `two_pass_translation` 필드도 함께 제거됐고, 옛 `config.json`에 남은 키는 무시된다(어느 구조체도 `deny_unknown_fields`를 쓰지 않음).
- 라이선스: **PolyForm Noncommercial 1.0.0** (2026-07 MIT에서 재라이선스). 비상업 사용 자유, 상업적 사용은 별도 허가. 재배포 시 `LICENSE`의 `Required Notice:` 고지 포함 필수. 모델 카탈로그의 라이선스 기준(위)과는 별개.
- **`%APPDATA%` JSON은 `utils::read_json_file`로 읽는다** (`config.json`·`presets.json`). `serde_json`은 BOM을 JSON으로 안 보고 `expected value at line 1 column 1`을 뱉는데, 이 파일을 건드릴 법한 Windows 도구들(PowerShell 5.1 `Set-Content -Encoding UTF8`, 메모장의 "UTF-8 with BOM")이 바로 그 BOM을 붙인다. 그래서 UTF-8 BOM은 벗겨내고, UTF-16(PS의 기본 `>` 리다이렉션)은 **인코딩을 지목하는 에러**로 거절한다 — 인코딩 추측은 남의 용어집을 깨먹는 방법이다. 파싱 실패 메시지에는 경로·줄·열이 들어간다.
  - `add_preset`/`update_preset`/`remove_preset`은 전부 `load_presets()`를 먼저 부른다. 그래서 파일이 깨지면 **"프리셋 저장 실패"**로 보인다. 원인 문자열을 토스트 description으로 넘기지 않으면 (`usePresets.ts`의 `reason()`) 저장 버그를 쫓다가 시간을 버린다. 실제로 그랬다.
- 앱 식별자: `LocalSub`, 데이터: `%APPDATA%/LocalSub/`
