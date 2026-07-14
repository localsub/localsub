// Tauri IPC mock — injected via page.addInitScript BEFORE the app boots.
// Defines window.__TAURI_INTERNALS__ so @tauri-apps/api invoke / convertFileSrc
// resolve against in-page fixtures instead of a real Tauri backend.
//
// This file touches NO production source. It exists only to drive the real
// React UI with curated data for landing-page screenshots.
(function () {
  "use strict";

  // ── Sample media: convertFileSrc returns this; capture.mjs routes it. ──
  var SAMPLE_MEDIA = "/__sample_media__.mp4";

  // ── Fixtures ───────────────────────────────────────────────────────
  var CONFIG = {
    version: 1,
    wizard_completed: true,
    wizard_step: 5,
    profile: "power",
    output_dir: "C:/Users/You/Videos/LocalSub",
    subtitle_format: "srt",
    source_language: "ja",
    target_language: "ko",
    translation_mode: "direct",
    context_window: 4,
    style_preset: "natural",
    external_api: { provider: null, api_key: null, model: null },
    model_dir: "C:/Users/You/AppData/Roaming/LocalSub/models",
    ui_language: "ko",
    active_whisper_model: "whisper-large-v3",
    active_llm_model: "qwen3-9b-q5km",
    max_concurrent_jobs: 1,
    gpu_acceleration: true,
    max_memory_mb: null,
    translation_quality: "balanced",
    custom_translation_prompt: null,
    two_pass_translation: false,
  };

  // Per-pass overrides (e.g. boot into the wizard for the profile shot).
  try { if (window.__MOCK_OVERRIDE__) Object.assign(CONFIG, window.__MOCK_OVERRIDE__); } catch (e) {}

  var VOCAB = [
    {
      id: "vocab-anime", name: "애니 고유명사", description: "작품별 인명·지명을 일관되게 고정",
      source_lang: "ja", target_lang: "ko",
      entries: [
        { id: "v1", source: "ユウキ", target: "유우키", note: "남자 주인공" },
        { id: "v2", source: "アヤ", target: "아야", note: "여자 주인공" },
        { id: "v3", source: "駅前", target: "역 앞" },
        { id: "v4", source: "缶コーヒー", target: "캔커피" },
        { id: "v5", source: "約束", target: "약속" },
        { id: "v6", source: "撤回", target: "취소" },
      ],
      created_at: "2026-05-03T00:00:00.000Z", updated_at: "2026-06-09T00:00:00.000Z",
    },
    {
      id: "vocab-tech", name: "기술 용어 (영→한)", description: "강연·다큐 전문 용어 통일",
      source_lang: "en", target_lang: "ko",
      entries: [
        { id: "t1", source: "entropy", target: "엔트로피" },
        { id: "t2", source: "inference", target: "추론" },
        { id: "t3", source: "quantization", target: "양자화" },
      ],
      created_at: "2026-05-10T00:00:00.000Z", updated_at: "2026-06-08T00:00:00.000Z",
    },
  ];

  var HARDWARE = {
    cpu_name: "AMD Ryzen 9 7950X",
    cpu_cores: 16,
    avx_support: true,
    avx2_support: true,
    total_ram_gb: 64,
    available_ram_gb: 41,
    gpu: { name: "NVIDIA GeForce RTX 4080", vram_mb: 16376, cuda_version: "12.4" },
  };

  // Subtitle fixture — a short drama scene, JA source + KO translation,
  // two speakers, mostly translated with one demo "untranslated" row.
  var SUBS = [
    ["ユウキ", "なあ、もう一度だけ言ってくれないか。", "있잖아, 한 번만 더 말해줄래?", "translated"],
    ["ユウキ", "さっきの言葉、ちゃんと聞き取れなかったんだ。", "방금 그 말, 제대로 못 들었어.", "translated"],
    ["アヤ", "別に。大したことじゃないよ。", "별거 아니야. 신경 쓰지 마.", "translated"],
    ["アヤ", "ただ…少しだけ疲れただけ。", "그냥… 조금 지쳤을 뿐이야.", "translated"],
    ["ユウキ", "そういう時こそ、話した方がいい。", "그럴 때일수록, 말하는 게 좋아.", "translated"],
    ["アヤ", "あなたはいつもそう言うね。", "넌 늘 그렇게 말하더라.", "translated"],
    ["アヤ", "でも、ありがとう。", "그래도, 고마워.", "translated"],
    ["ユウキ", "明日、駅前で待ってる。", "내일, 역 앞에서 기다릴게.", "translated"],
    ["ユウキ", "雨が降っても、ちゃんと行くから。", "비가 와도, 꼭 갈 테니까.", "translated"],
    ["アヤ", "うん。約束だよ。", "응. 약속이야.", "translated"],
    ["アヤ", "今度は私が、先に着いてみせる。", "이번엔 내가, 먼저 도착해 보일게.", "translated"],
    ["ユウキ", "へえ、言ったな?", "오, 방금 말했다?", "translated"],
    ["アヤ", "言った。撤回はしない。", "말했어. 취소는 안 해.", "translated"],
    ["ユウキ", "じゃあ、賭けにしよう。", "그럼, 내기로 하자.", "untranslated"],
    ["アヤ", "負けた方が、缶コーヒー奢りね。", "진 사람이, 캔커피 사기다.", "translated"],
  ];

  function buildSubtitleLines() {
    var t = 1.2;
    return SUBS.map(function (row, i) {
      var dur = 1.6 + (i % 3) * 0.5;
      var start = t;
      t += dur + 0.25;
      return {
        id: "line-" + i,
        index: i + 1,
        start_time: start,
        end_time: start + dur,
        original_text: row[1],
        translated_text: row[3] === "untranslated" ? "" : row[2],
        speaker: row[0],
        status: row[3],
      };
    });
  }

  // Built lazily so timestamps are relative to the real clock (→ "방금 전").
  // Note: the app flips any saved "processing" job to "failed" on load
  // (restart recovery), so we use completed/pending only.
  function buildDashboardJobs() {
    var now = Date.now();
    var min = 60000;
    var iso = function (ms) { return new Date(ms).toISOString(); };
    return [
      {
        id: "job-001", file_name: "雨の約束_第3話.mkv",
        file_path: "D:/Media/雨の約束_第3話.mkv",
        file_size: 1492 * 1024 * 1024, duration: 1423,
        preset_id: "preset-anime", status: "completed", stage: "done", progress: 100,
        created_at: iso(now - 8 * min), completed_at: iso(now - 2 * min),
      },
      {
        id: "job-002", file_name: "interview_keynote_2026.mp4",
        file_path: "D:/Media/interview_keynote_2026.mp4",
        file_size: 884 * 1024 * 1024, duration: 2710,
        preset_id: "preset-doc", status: "completed", stage: "done", progress: 100,
        created_at: iso(now - 21 * min), completed_at: iso(now - 12 * min),
      },
      {
        id: "job-003", file_name: "podcast_ep148.mp3",
        file_path: "D:/Media/podcast_ep148.mp3",
        file_size: 71 * 1024 * 1024, duration: 3120,
        preset_id: "preset-doc", status: "completed", stage: "done", progress: 100,
        created_at: iso(now - 40 * min), completed_at: iso(now - 27 * min),
      },
      {
        id: "job-004", file_name: "lecture_thermodynamics.mp4",
        file_path: "D:/Media/lecture_thermodynamics.mp4",
        file_size: 1230 * 1024 * 1024, duration: 4015,
        preset_id: "preset-doc", status: "pending", stage: "stt", progress: 0,
        created_at: iso(now - 1 * min),
      },
    ];
  }

  var PRESETS = [
    {
      id: "preset-anime", name: "애니 · 일→한", description: "캐주얼 구어체, 화자 분리",
      whisper_model: "whisper-large-v3", source_lang: "ja", target_lang: "ko",
      output_format: "srt", translation_style: "casual", llm_model: "qwen3-9b-q5km",
      vocabulary_id: null, is_default: true, translation_quality: "balanced",
      enable_diarization: true, media_type: "animation", translation_mode: "direct",
      created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "preset-doc", name: "다큐/강연 · 영→한", description: "정중체, 용어집 적용",
      whisper_model: "whisper-large-v3", source_lang: "en", target_lang: "ko",
      output_format: "srt", translation_style: "formal", llm_model: "qwen3-9b-q5km",
      vocabulary_id: null, translation_quality: "best",
      enable_diarization: false, media_type: "documentary", translation_mode: "direct",
      created_at: "2026-05-02T00:00:00.000Z", updated_at: "2026-05-02T00:00:00.000Z",
    },
  ];

  var MANIFEST = {
    version: 1,
    updated_at: "2026-06-09T00:00:00.000Z",
    models: [
      { id: "whisper-large-v3", model_type: "whisper", name: "Whisper large-v3",
        path: "models/whisper-large-v3", size_bytes: 3094000000,
        sha256: "a1b2", status: "ready", installed_at: "2026-05-01T00:00:00.000Z" },
      { id: "qwen3-9b-q5km", model_type: "llm", name: "Qwen3 9B (Q5_K_M)",
        path: "models/qwen3-9b-q5km", size_bytes: 6530000000,
        sha256: "c3d4", status: "ready", installed_at: "2026-05-01T00:00:00.000Z" },
    ],
  };

  var CATALOG = {
    version: 1,
    whisper_models: [
      { id: "whisper-large-v3", name: "Whisper large-v3", repo: "Systran/faster-whisper-large-v3",
        files: ["model.bin"], total_size_bytes: 3094000000, sha256: {}, profiles: ["power", "balanced"] },
      { id: "whisper-medium", name: "Whisper medium", repo: "Systran/faster-whisper-medium",
        files: ["model.bin"], total_size_bytes: 1530000000, sha256: {}, profiles: ["balanced", "lite"] },
    ],
    llm_models: [
      { id: "qwen3-9b-q5km", name: "Qwen3 9B (Q5_K_M)", repo: "Qwen/Qwen3-9B-GGUF",
        filename: "qwen3-9b-q5_k_m.gguf", size_bytes: 6530000000, sha256: "c3d4",
        quant: "Q5_K_M", profiles: ["power"], n_gpu_layers_default: 99, model_category: "general" },
      { id: "qwen3-4b-q5km", name: "Qwen3 4B (Q5_K_M)", repo: "Qwen/Qwen3-4B-GGUF",
        filename: "qwen3-4b-q5_k_m.gguf", size_bytes: 2980000000, sha256: "e5f6",
        quant: "Q5_K_M", profiles: ["balanced"], n_gpu_layers_default: 99, model_category: "general" },
    ],
  };

  // ── Command dispatch ───────────────────────────────────────────────
  function dispatch(cmd, args) {
    switch (cmd) {
      case "get_config": return CONFIG;
      case "update_config": return CONFIG;
      case "check_setup": return "COMPLETE";
      case "run_setup": return null;
      case "get_server_status": return "RUNNING";
      case "start_server": case "stop_server": case "restart_server": return null;
      case "get_runtime_status": return { whisper: "READY", llm: "READY" };
      case "detect_hardware": return HARDWARE;
      case "recommend_profile":
        return { recommended: "power", reason: "RTX 4080 detected", gpu_detected: true, gpu_vram_mb: 16376 };
      case "check_disk_space":
        return { path: "C:/", total_gb: 1862, free_gb: 612 };
      case "check_ffmpeg": return true;
      case "get_ffmpeg_path": return "C:/Program Files/LocalSub/ffmpeg.exe";
      case "get_jobs": return [];
      case "load_dashboard_jobs": return buildDashboardJobs();
      case "save_dashboard_jobs": return null;
      case "load_job_subtitles": return buildSubtitleLines();
      case "save_job_subtitles": return null;
      case "get_presets": return PRESETS;
      case "get_vocabularies": return VOCAB;
      case "get_model_manifest": return MANIFEST;
      case "get_model_catalog": return CATALOG;
      case "verify_model": return true;
      // Event plugin (listen/unlisten) — register no-op, return a fake id.
      case "plugin:event|listen": return ++eventId;
      case "plugin:event|unlisten": return null;
      case "plugin:notification|is_permission_granted": return true;
      case "plugin:notification|request_permission": return "granted";
      default: return null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────
  var cbId = 0, eventId = 0;
  var callbacks = {};

  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd, args) {
      try {
        return Promise.resolve(dispatch(cmd, args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    transformCallback: function (cb, once) {
      var id = ++cbId;
      callbacks[id] = cb;
      return id;
    },
    unregisterCallback: function (id) { delete callbacks[id]; },
    convertFileSrc: function (_path, _protocol) { return SAMPLE_MEDIA; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () { return Promise.resolve(); },
  };
})();
