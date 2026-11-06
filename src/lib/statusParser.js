/**
 * 固件状态行解析 —— 对应 ats-mini/Remote.cpp 的 remotePrintStatus()
 *
 * 状态流每 500ms 推一行，字段分两段：
 *
 * 【原始 15 字段，任何固件版本都不变】
 *   0  固件版本 VER_APP（245 = v2.45）
 *   1  频率     FM 为 10kHz 单位，AM/SSB 为 1kHz 单位
 *   2  BFO      SSB 下为 Hz
 *   3  校准值
 *   4  波段名
 *   5  模式     FM / LSB / USB / AM
 *   6  步进描述
 *   7  带宽描述
 *   8  AGC 索引
 *   9  音量
 *   10 RSSI
 *   11 SNR
 *   12 调谐电容
 *   13 ADC 电压原值（电压 = 值 × 1.702 / 1000）
 *   14 序号
 *
 * 【汉化固件追加的界面状态，旧固件没有】
 *   15 currentCmd  当前界面（见 CMD_* 表），这是「屏幕一模一样」的关键
 *   16 背光值
 *   17 息屏中（1 = 已休眠）
 *   18 静音中
 *   19 主界面布局
 *   20 主菜单光标
 *   21 设置菜单光标
 *   22 定时待机剩余分钟
 *   23 关机定时剩余分钟
 *   24 休眠定时设定值（秒）
 *   25 编码器档位（1 = 30定位/15脉冲）
 *
 * 旧固件只推到第 14 字段，此时 hasUi 为 false，调用方退回本地状态机推断。
 */

export const BASE_FIELDS = 15;
export const EXT_FIELDS = 26;

// Menu.h 的 CMD_* → 渲染器用的 ui 键
export const CMD_TO_UI = {
  0x0000: 'info',
  0x0100: 'info',      // CMD_FREQ 频率输入，仍是主界面
  0x1000: 'band',
  0x1100: 'volume',
  0x1200: 'agc',
  0x1300: 'bw',
  0x1400: 'step',
  0x1500: 'mode',
  0x1600: 'menu',
  0x1700: 'softmute',
  0x1800: 'avc',
  0x1900: 'memory',
  0x1a00: 'seek',
  0x1b00: 'scan',
  0x1c00: 'squelch',
  0x2000: 'settings',
  0x2100: 'brt',
  0x2200: 'cal',
  0x2300: 'rds',
  0x2400: 'utcoffset',
  0x2500: 'fm_region',
  0x2600: 'theme',
  0x2700: 'ui',
  0x2800: 'zoom',
  0x2900: 'scroll',
  0x2a00: 'sleep',
  0x2b00: 'sleepmode',
  0x2c00: 'eibi',
  0x2d00: 'usbmode',
  0x2e00: 'tcpmode',
  0x2f00: 'blemode',
  0x3000: 'wifimode',
  0x3100: 'datetime',
  0x3200: 'updatefw',
  0x3300: 'fm_stereo',
  0x3400: 'dsp',
  0x3500: 'about',
  0x3600: 'offtimer',
  0x3700: 'stbytimer',
  0x3800: 'encoder',
};

export const uiFromCmd = (cmd) => CMD_TO_UI[cmd] || 'info';

/**
 * 解析一行状态流。
 * @returns {{monitor: object, ui: object|null}|null}
 *   monitor —— 数值类状态，供面板与测量显示
 *   ui      —— 界面状态；旧固件（不足 26 字段）时为 null
 */
export function parseStatusLine(line) {
  if (!line || !line.includes(',')) return null;

  const v = line.split(',');
  if (v.length < BASE_FIELDS) return null;

  // 前 15 字段可能粘着上一次命令的回显（例如保存电台时的 "Ok"），
  // 只认第 0 个字段是纯数字的行，避免把回显误当状态。
  const appVersion = parseInt(v[0], 10);
  if (!Number.isFinite(appVersion)) return null;

  const isFM = v[5] === 'FM';
  const freqValue = parseFloat(v[1]);
  const frequency = Number.isFinite(freqValue) ? freqValue * (isFM ? 10000 : 1000) : 0;

  const adcValue = parseFloat(v[13]);
  const voltage = Number.isFinite(adcValue) ? (adcValue * 1.702) / 1000 : 0;

  const hasUi = v.length >= EXT_FIELDS;

  const monitor = {
    firmware: appVersion > 200
      ? `v${Math.floor(appVersion / 100)}.${appVersion % 100}`
      : 'v2.x',
    frequency,
    band: v[4] || '',
    mode: v[5] || 'AM',
    step: v[6] || '',
    bandwidth: v[7] || '',
    agc: parseInt(v[8], 10) || 0,
    volume: parseInt(v[9], 10) || 0,
    rssi: parseInt(v[10], 10) || 0,
    snr: parseInt(v[11], 10) || 0,
    tuningCapacitor: parseInt(v[12], 10) || 0,
    voltage,
    calibration: parseInt(v[3], 10) || 0,
    bfo: parseInt(v[2], 10) || 0,
    seq: parseInt(v[14], 10) || 0,
    // 实际收到的字段数。界面靠它判断收音机跑的固件是否配套：
    // 15 = 原版固件，≥26 = 汉化配套固件。App 用它在屏幕上直说，不再假装同步。
    fields: v.length,
  };

  if (!hasUi) {
    // 旧固件：背光与息屏状态只能本地维护，界面也只能靠状态机推断
    return { monitor: { ...monitor, fields: v.length, backlight: undefined, sleep: false }, ui: null };
  }

  const cmd = parseInt(v[15], 10) || 0;
  const sleep = v[17] === '1';

  const ui = {
    cmd,
    ui: uiFromCmd(cmd),
    backlight: parseInt(v[16], 10) || 0,
    sleep,
    muted: v[18] === '1',
    layout: parseInt(v[19], 10) || 0,
    menuIdx: parseInt(v[20], 10) || 0,
    settingsIdx: parseInt(v[21], 10) || 0,
    standbyTimer: parseInt(v[22], 10) || 0,
    offTimer: parseInt(v[23], 10) || 0,
    sleepTimer: parseInt(v[24], 10) || 0,
    encoderHalfStep: v[25] === '1',
    stereo: v[26] === '1',
    option: parseInt(v[27], 10) || 0,
    vfo: parseInt(v[28], 10) || 0,
  };

  return {
    monitor: { ...monitor, backlight: ui.backlight, sleep },
    ui,
  };
}
