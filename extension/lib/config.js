// Extension-wide config. Change API_BASE to point at local dev server if needed.
// In prod, this points at the deployed Vercel serverless functions.
export const API_BASE = 'https://vaak-setu.vercel.app/api';

// Language catalogs — mirror src/App.jsx so the popup knows what to offer.
export const INDIAN_LANGS = [
  { code: 'hi-IN', name: 'Hindi',     native: 'हिन्दी' },
  { code: 'en-IN', name: 'English',   native: 'English' },
  { code: 'bn-IN', name: 'Bengali',   native: 'বাংলা' },
  { code: 'gu-IN', name: 'Gujarati',  native: 'ગુજરાતી' },
  { code: 'kn-IN', name: 'Kannada',   native: 'ಕನ್ನಡ' },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'mr-IN', name: 'Marathi',   native: 'मराठी' },
  { code: 'or-IN', name: 'Odia',      native: 'ଓଡ଼ିଆ' },
  { code: 'pa-IN', name: 'Punjabi',   native: 'ਪੰਜਾਬੀ' },
  { code: 'ta-IN', name: 'Tamil',     native: 'தமிழ்' },
  { code: 'te-IN', name: 'Telugu',    native: 'తెలుగు' },
];

export const INTL_LANGS = [
  { code: 'es', name: 'Spanish',    native: 'Español' },
  { code: 'fr', name: 'French',     native: 'Français' },
  { code: 'de', name: 'German',     native: 'Deutsch' },
  { code: 'ja', name: 'Japanese',   native: '日本語' },
  { code: 'zh', name: 'Chinese',    native: '中文' },
  { code: 'ar', name: 'Arabic',     native: 'العربية' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'ru', name: 'Russian',    native: 'Русский' },
  { code: 'it', name: 'Italian',    native: 'Italiano' },
  { code: 'ko', name: 'Korean',     native: '한국어' },
  { code: 'nl', name: 'Dutch',      native: 'Nederlands' },
  { code: 'tr', name: 'Turkish',    native: 'Türkçe' },
  { code: 'pl', name: 'Polish',     native: 'Polski' },
  { code: 'sv', name: 'Swedish',    native: 'Svenska' },
  { code: 'th', name: 'Thai',       native: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'uk', name: 'Ukrainian',  native: 'Українська' },
];

export const ALL_LANGS = [...INDIAN_LANGS, ...INTL_LANGS];

// Full catalogs. Earlier we trimmed these to two pairs while optimizing
// latency / cost — restored to the complete sets now.
export const PICKER_INDIAN_LANGS = INDIAN_LANGS;
export const PICKER_INTL_LANGS   = INTL_LANGS;

export function isIndianLang(code) {
  return INDIAN_LANGS.some((l) => l.code === code);
}

export function getLang(code) {
  return ALL_LANGS.find((l) => l.code === code) || { code, name: code, native: code };
}
