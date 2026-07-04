import React, { createContext, useContext, useState, useCallback } from 'react';
import { en } from './en';
import { zh } from './zh';

// ============================================================
// i18n Translations - Combined dictionary
// ============================================================
export const TRANSLATIONS = { en, zh } as const;

export type Lang = 'en' | 'zh';
type WidenLiteral<T> =
  T extends (...args: any[]) => any ? T :
  T extends string ? string :
  T extends number ? number :
  T extends boolean ? boolean :
  T extends readonly unknown[] ? T :
  { readonly [K in keyof T]: WidenLiteral<T[K]> };
export type Translations = WidenLiteral<(typeof TRANSLATIONS)['en']>;

interface I18nContextType {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translations;
}

export const I18nContext = createContext<I18nContextType>({
  lang: 'en',
  setLang: () => {},
  t: TRANSLATIONS.en,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('zh');
  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const t = TRANSLATIONS[lang];

  // Load language preference from settings on mount
  React.useEffect(() => {
    if (window.api) {
      window.api.loadSettings().then((settings: any) => {
        if (settings?.language && (settings.language === 'en' || settings.language === 'zh')) {
          setLangState(settings.language);
        }
      }).catch(() => {});
    }
  }, []);

  return React.createElement(
    I18nContext.Provider,
    { value: { lang, setLang, t } },
    children
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
