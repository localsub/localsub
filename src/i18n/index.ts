import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ko from "./locales/ko.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";
import es from "./locales/es.json";

const SUPPORTED_LANGS = ["en", "ko", "ja", "zh-CN", "es"];

function detectLanguage(): string {
  const stored = localStorage.getItem("ui_language");
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  const nav = navigator.language;
  if (SUPPORTED_LANGS.includes(nav)) return nav;
  const lang = nav.split("-")[0];
  if (SUPPORTED_LANGS.includes(lang)) return lang;
  // zh -> zh-CN fallback
  if (lang === "zh") return "zh-CN";
  return "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
    ja: { translation: ja },
    "zh-CN": { translation: zhCN },
    es: { translation: es },
  },
  lng: detectLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
