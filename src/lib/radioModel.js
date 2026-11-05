/**
 * ATS-Mini 遥控状态机 —— 严格复刻固件 currentCmd 逻辑
 *
 * 依据固件源码：
 *   Button.cpp       按键判定：<500ms 为 click，500~2000ms 为 shortPress，>2000ms 长按
 *   ats-mini.ino     handleClick() / handleRotation() / ELAPSED_COMMAND
 *   Menu.cpp         clickHandler() / clickMenu() / clickSettings() / doSideBar()
 *
 * 关键事实（以前 App 猜错，导致面板和真机不一致）：
 *   1. `int8_t menuIdx = MENU_VOLUME;` —— 主菜单默认高亮「音量」，不是第一项「模式」
 *   2. 子菜单里再按一下 = 回信息框（currentCmd = CMD_NONE），不是回上级菜单
 *   3. 10 秒无操作自动回 CMD_NONE（SEEK/SCAN/MEMORY 除外）
 *   4. FM 下没有 AVC / 软静音 / 存储/校准等项，点击直接无效
 *
 * 这里只维护「面板状态 + 列表光标」，频率/音量/波段等数值一律以固件监视器回传为准。
 */

// Menu.cpp menu[] / settings[] 项数
export const MENU_COUNT = 14;
export const SETTINGS_COUNT = 22;

// 固件 int8_t menuIdx = MENU_VOLUME; settingsIdx = MENU_BRIGHTNESS;
export const MENU_DEFAULT_IDX = 2;
export const SETTINGS_DEFAULT_IDX = 0;

// ats-mini.ino: #define ELAPSED_COMMAND 10000
export const CMD_IDLE_MS = 10000;

// 这三类命令在固件里不会超时回 NONE
const NO_TIMEOUT = new Set(['seek', 'scan', 'memory']);

// 主菜单 → 子面板（顺序 = Menu.cpp #define MENU_xxx）
export const MENU_TO_CMD = [
  'mode', 'band', 'volume', 'vfo', 'step', 'seek', 'scan',
  'memory', 'squelch', 'bw', 'agc', 'avc', 'softmute', 'settings',
];

// 设置菜单 → 子面板（顺序 = Menu.cpp #define MENU_xxx）
export const SETTINGS_TO_CMD = [
  'brt', 'datetime', 'utcoffset', 'sleep', 'sleepmode', 'offtimer', 'theme', 'ui',
  'zoom', 'scroll', 'rds', 'fm_stereo', 'fm_region', 'cal', 'dsp', 'eibi',
  'updatefw', 'usbmode', 'tcpmode', 'blemode', 'wifimode', 'about',
];

// 各模式独立的步进档位（Menu.cpp steps[4]）
export const STEPS_BY_MODE = {
  FM: ['10k', '50k', '100k', '200k', '1M'],
  LSB: ['10', '25', '50', '100', '500', '1k', '5k', '9k', '10k'],
  USB: ['10', '25', '50', '100', '500', '1k', '5k', '9k', '10k'],
  AM: ['1k', '5k', '9k', '10k', '50k', '100k', '1M'],
};

// 各模式独立的带宽档位（Menu.cpp bandwidths[4]）
export const BW_BY_MODE = {
  FM: ['Auto', '110k', '84k', '60k', '40k'],
  LSB: ['0.5k', '1.0k', '1.2k', '2.2k', '3.0k', '4.0k'],
  USB: ['0.5k', '1.0k', '1.2k', '2.2k', '3.0k', '4.0k'],
  AM: ['1.0k', '1.8k', '2.0k', '2.5k', '3.0k', '4.0k', '6.0k'],
};

const MODE_NAMES = ['FM', 'LSB', 'USB', 'AM'];
const wrap = (v, n) => ((v % n) + n) % n;

export function createModel() {
  return {
    cmd: 'none',              // none | menu | settings | volume | mode | …
    menuIdx: MENU_DEFAULT_IDX,
    settingsIdx: SETTINGS_DEFAULT_IDX,
    lastAct: Date.now(),
  };
}

export const isListState = (cmd) => cmd === 'menu' || cmd === 'settings';

/** 这些面板里旋转不应该改变频率，若频率变了说明真机根本不在这个面板 */
export const FREQ_HEAL_STATES = new Set(['menu', 'settings', 'volume']);

function ctxOf(monitor) {
  const modeName = monitor?.mode || 'AM';
  const mode = Math.max(0, MODE_NAMES.indexOf(modeName));
  return { mode, isSSB: mode === 1 || mode === 2, modeName };
}

/**
 * 按压（固件 handleClick）
 * @param {object} m  状态机
 * @param {boolean} shortPress  true = 按住 0.5~2 秒后松开（走 'E'）
 */
export function onPress(m, shortPress, monitor) {
  m.lastAct = Date.now();
  const { mode } = ctxOf(monitor);

  if (m.cmd === 'none') {
    // clickHandler(CMD_NONE) 返回 false → shortPress ? CMD_VOLUME : CMD_MENU
    m.cmd = shortPress ? 'volume' : 'menu';
    return;
  }

  switch (m.cmd) {
    case 'menu': {
      const next = MENU_TO_CMD[wrap(m.menuIdx, MENU_COUNT)];
      m.cmd = 'none';                       // clickMenu() 先置 NONE
      if (next === 'vfo') return;           // clickVfo：切换 A/B 后仍在 NONE
      if (next === 'avc' && mode === 0) return;      // FM 无 AVC
      if (next === 'softmute' && mode === 0) return; // FM 无软静音
      m.cmd = next;
      return;
    }

    case 'settings': {
      const next = SETTINGS_TO_CMD[wrap(m.settingsIdx, SETTINGS_COUNT)];
      m.cmd = 'none';
      if (next === 'cal' && !(mode === 1 || mode === 2)) return; // 仅 SSB 可校准
      if (next === 'offtimer' && shortPress) return;             // 短按 = 直接关机
      if (next === 'eibi') return;                              // 直接加载后回信息框
      m.cmd = next;
      return;
    }

    // clickVolume：短按切静音，长按回信息框
    case 'volume':
      if (!shortPress) m.cmd = 'none';
      return;

    // clickSeek / clickScan：短按继续执行，长按回信息框
    case 'seek':
    case 'scan':
      if (!shortPress) m.cmd = 'none';
      return;

    // clickMemory：短按 = 保存/删除当前槽，命令保持 MEMORY；点击才退出
    case 'memory':
      if (!shortPress) m.cmd = 'none';
      return;

    // clickDateTime：点击换字段（留在面板），短按 = 存时间后回信息框
    case 'datetime':
      if (shortPress) m.cmd = 'none';
      return;

    case 'squelch':
      if (!shortPress) m.cmd = 'none';
      return;

    case 'avc':
      if (!(shortPress && (mode === 1 || mode === 2))) m.cmd = 'none';
      return;

    default:
      // clickHandler 里没有对应分支 → 返回 false → currentCmd = CMD_NONE
      m.cmd = 'none';
  }
}

/** 旋转：只改光标类面板的下标（数值面板以监视器回传为准） */
export function onRotate(m, dir, monitor) {
  m.lastAct = Date.now();
  switch (m.cmd) {
    case 'menu':
      m.menuIdx = wrap(m.menuIdx + dir, MENU_COUNT);
      break;
    case 'settings':
      m.settingsIdx = wrap(m.settingsIdx + dir, SETTINGS_COUNT);
      break;
    default:
      break;
  }
}

/** 10 秒无操作自动回 CMD_NONE；返回是否发生了变化 */
export function onTick(m, now = Date.now()) {
  if (m.cmd === 'none' || NO_TIMEOUT.has(m.cmd)) return false;
  if (now - m.lastAct < CMD_IDLE_MS) return false;
  m.cmd = 'none';
  m.lastAct = now;
  return true;
}

/** 面板 → 渲染器的 ui 键（'none' 即左侧信息框） */
export function uiKey(m) {
  return m.cmd === 'none' ? 'info' : m.cmd;
}

export { MODE_NAMES };
