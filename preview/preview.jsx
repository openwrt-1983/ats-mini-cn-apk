import { renderScreen, DEFAULT_STATE } from '../src/lib/screenRenderer';

const base = {
  ...DEFAULT_STATE,
  freq: 15000000,
  mode: 3,
  bandName: 'SW',
  rssi: 62,
  snr: 24,
  volume: 28,
  agcNdx: 0,
  agcOn: true,
  stepDesc: '5k',
  bwDesc: '3.0k',
  battery: 4.02,
  muted: false,
};

// 与真机照片同一状态：VHF 97.00 FM，RSSI 39，SNR 18
const fmBase = {
  ...base,
  bandName: 'VHF',
  mode: 0,
  freq: 97000000,
  rssi: 39,
  snr: 18,
  volume: 30,
  stepDesc: '100k',
  bwDesc: 'Auto',
  agcOn: true,
  avcDesc: 'n/a',
  battery: 4.12,
};

const CASES = [
  {
    title: '★ S-Meter 布局（照你的照片复原）',
    note: 'uiLayout=1 · 左侧信息框贴顶（y=0）、中间 64.00–108.00 小刻度尺、底部 S/N 双条表。RSSI 39 在 FM 表插值 → 36 格（绿 28 + 红 8），SNR 18 → 6 格，与你照片完全一致。',
    st: { ...fmBase, ui: 'info', uiLayout: 1 },
  },
  {
    title: '默认布局 · 同一状态',
    note: 'uiLayout=0 · 同一组数值换回默认排版：左面板下移 18px、底部换成频率游标尺、S 表缩到左上角',
    st: { ...fmBase, ui: 'info', uiLayout: 0 },
  },
  {
    title: 'S-Meter 布局 · FM 立体声',
    note: '收到立体声导频时，频率右侧显示「双环」立体声指示（ALT_STEREO 251,24），与默认布局的小图标不同',
    st: { ...fmBase, ui: 'info', uiLayout: 1, stereo: true },
  },
  {
    title: '界面布局面板',
    note: 'CMD_UI · 就是切「默认 / S-Meter」的那一屏，高亮项由固件回报（st.option）',
    st: { ...fmBase, ui: 'ui', uiLayout: 1, option: 1 },
  },
  {
    title: 'S-Meter 布局 · 音量面板',
    note: '同一布局下侧边栏整体上移到 y=0，面板不会压在刻度尺上',
    st: { ...fmBase, ui: 'volume', uiLayout: 1 },
  },
  {
    title: '信息框（idle）',
    note: 'CMD_NONE · 左侧显示步进/带宽/AGC，右下角 SNR / RSSI',
    st: { ...base, ui: 'info' },
  },
  {
    title: '主菜单',
    note: 'CMD_MENU · 光标默认停在第 3 项「音量」',
    st: { ...base, ui: 'menu', menuIdx: 2 },
  },
  {
    title: '设置菜单 · 第 6 项',
    note: '高亮「定时待机」——这一项旧版 App 整个漏掉，导致从第 5 项起全部错位',
    st: { ...base, ui: 'settings', settingsIdx: 5 },
  },
  {
    title: '定时待机面板',
    note: 'CMD_STBYTIMER · 大字剩余分钟 + 小字「分」，为 0 时显示「关」',
    st: { ...base, ui: 'stbytimer', standbyTimer: 35 },
  },
  {
    title: '编码器面板',
    note: 'CMD_ENCODER · 大字档位 + 小字脉冲数（旧版 App 没有这一项）',
    st: { ...base, ui: 'encoder', encoderHalfStep: true },
  },
  {
    title: '亮度面板',
    note: 'CMD_BRT · 背光值改为固件实测，不再是写死的 5',
    st: { ...base, ui: 'brt', backlight: 7 },
  },
  {
    title: '静音 + 音量',
    note: 'CMD_VOLUME · 静音时数字上划 7 道斜线',
    st: { ...base, ui: 'volume', volume: 28, muted: true },
  },
  {
    title: '休眠中',
    note: '真机熄屏，App 同步黑屏（不是卡住，是状态一致）',
    st: { ...base, ui: 'info', sleep: true },
  },
];

function buildCard({ title, note, st }) {
  const wrap = document.createElement('section');
  wrap.className = 'card';

  const h = document.createElement('h2');
  h.textContent = title;
  wrap.appendChild(h);

  const cv = document.createElement('canvas');
  cv.width = 320 * 2;
  cv.height = 170 * 2;
  cv.className = 'screen';
  const ctx = cv.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  renderScreen(ctx, st);
  wrap.appendChild(cv);

  const p = document.createElement('p');
  p.textContent = note;
  wrap.appendChild(p);
  return wrap;
}

const root = document.getElementById('grid');
CASES.forEach((c) => root.appendChild(buildCard(c)));
