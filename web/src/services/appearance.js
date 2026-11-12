import { theme } from 'antd';

export const isFontScale = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 1 && value <= 2 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-8;
export const normalizeFontScale = value => isFontScale(value) ? value : 1;

const baseToken = {
  colorPrimary: '#167963', colorPrimaryHover: '#0d6653', colorPrimaryActive: '#095642', colorInfo: '#167963',
  colorBgBase: '#f3f5f1', colorTextBase: '#19251f', colorTextDisabled: '#5d7062',
  colorBgContainerDisabled: '#eef1ec', borderRadius: 8,
  fontFamily: '"Instrument Sans", "Avenir Next", "Segoe UI", sans-serif', fontSize: 13, controlHeight: 36,
};
const baseDesign = theme.getDesignToken({ algorithm: theme.defaultAlgorithm, token: baseToken });

// Ant Design derives headings nonlinearly from its seed fontSize. Scale the
// original derived sizes explicitly so 2 means exactly twice every text size.
export function appearanceTheme(value) {
  const scale = normalizeFontScale(value);
  const typography = Object.fromEntries(Object.entries(baseDesign)
    .filter(([key, token]) => /^font(?:Size|Height)/.test(key) && typeof token === 'number')
    .map(([key, token]) => [key, token * scale]));
  return {
    algorithm: theme.defaultAlgorithm,
    token: { ...baseToken, ...typography, controlHeight: baseDesign.controlHeight * scale,
      controlHeightSM: baseDesign.controlHeightSM * scale, controlHeightLG: baseDesign.controlHeightLG * scale,
      controlHeightXS: baseDesign.controlHeightXS * scale },
    components: { Table: { headerBg: '#eaf0e9', rowHoverBg: '#eef4ed' }, Button: { primaryShadow: 'none' } },
  };
}
