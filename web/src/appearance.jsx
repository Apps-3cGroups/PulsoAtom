import { createContext, useContext, useLayoutEffect } from 'react';
import { normalizeFontScale } from './services/appearance';
import './appearance.css';

const AppearanceContext = createContext({ fontScale: 1, setAppearance: () => {} });
export const useAppearance = () => useContext(AppearanceContext);

export function AppearanceProvider({ fontScale: value = 1, setAppearance, children }) {
  const fontScale = normalizeFontScale(value);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
    document.documentElement.dataset.largeText = String(fontScale > 1);
  }, [fontScale]);
  return <AppearanceContext.Provider value={{ fontScale, setAppearance }}>{children}</AppearanceContext.Provider>;
}
