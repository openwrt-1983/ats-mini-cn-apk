/**
 * ATS-Mini 真机屏幕 1:1 复刻渲染器
 *
 * 严格依据固件源码绘制，坐标系与真机 LCD 完全一致（320 × 170 逻辑像素）：
 *   Layout-Default.cpp  drawLayoutDefault()   主界面绘制顺序
 *   Draw.cpp            drawFrequency / drawBandAndMode / drawSMeter /
 *                       drawScale / drawStationName / drawSaveIndicator /
 *                       drawBleIndicator / drawWiFiIndicator / drawStereoIndicator
 *   Battery.cpp         drawBattery()
 *   Menu.cpp            drawInfo()（左侧信息框，菜单空闲时显示）
 *   Themes.cpp          theme[0] "Default" 配色
 *   Draw.h              全部 X/Y 偏移常量
 *   Common.h            DISPLAY_WIDTH/HEIGHT、字体映射、模式编号
 *
 * 字体对应（LovyanGFX）：
 *   FONT_DIGITS = Font7  48px 七段数码，数字宽 32px（本文件按源码坐标自绘）
 *   FONT_LARGE  = Font4  16×26 点阵
 *   FONT_SMALL  = Font2  8×16 点阵
 *   波段名用 Orbitron_Light_24
 */

export const SW = 320;
export const SH = 170;

// 固件 Draw.h 偏移常量
export const LAYOUT = {
  MENU_X: 0, MENU_Y: 18, MENU_DX: 10,
  METER_X: 0, METER_Y: 0,
  SAVE_X: 90, SAVE_Y: 0,
  FREQ_X: 250, FREQ_Y: 62,
  FUNIT_X: 255, FUNIT_Y: 62 - 23,
  BAND_X: 150, BAND_Y: 9,
  RDS_X: 165, RDS_Y: 94,
  STATUS_X: 160, STATUS_Y: 135,
  BATT_X: 288, BATT_Y: 0,
  WIFI_X: 237, WIFI_Y: 0,
  BLE_X: 104, BLE_Y: 0,
  // Draw.h：S-Meter 布局（UI_SMETER）专用偏移
  ALT_MENU_X: 0, ALT_MENU_Y: 0,
  ALT_METER_X: 75, ALT_METER_Y: 136,
  ALT_STEREO_X: 251, ALT_STEREO_Y: 24,
};

// 侧边栏原点：随布局切换（默认 MENU_Y=18 / S-Meter ALT_MENU_Y=0）
let SB_X = LAYOUT.MENU_X;
let SB_Y = LAYOUT.MENU_Y;

// Themes.cpp theme[0] "Default"，RGB565 已转 RGB888
export const THEME_DEFAULT = {
  bg: '#000000',
  text: '#ffffff',
  smeter_icon: '#d0d0d0',
  smeter_bar: '#00fc00',
  smeter_bar_plus: '#ff0000',
  smeter_bar_empty: '#303030',
  save_icon: '#ff0000',
  rf_icon: '#ff0000',
  rf_icon_conn: '#00fc00',
  batt_voltage: '#ffffff',
  batt_border: '#ffffff',
  batt_full: '#00fc00',
  batt_low: '#ff0000',
  batt_charge: '#000000',
  batt_icon: '#ffff00',
  band_text: '#d0d0d0',
  mode_text: '#d0d0d0',
  mode_border: '#d0d0d0',
  box_bg: '#000000',
  box_border: '#d0d0d0',
  box_text: '#d0d0d0',
  box_off_bg: '#ff0000',
  box_off_text: '#b8d8f8',
  menu_bg: '#000000',
  menu_border: '#ff0000',
  menu_hdr: '#ffffff',
  menu_item: '#bddaFF',
  menu_hl_bg: '#1004de',
  menu_hl_text: '#bddaFF',
  menu_param: '#bddaFF',
  freq_text: '#ffffff',
  funit_text: '#d0d0d0',
  freq_hl: '#ff0000',
  freq_hl_sel: '#ffff00',
  rds_text: '#d0d0d0',
  scale_text: '#ffffff',
  scale_pointer: '#ff0000',
  scale_line: '#c0c4c0',
};

// 模式编号与固件一致：FM=0 LSB=1 USB=2 AM=3
export const MODE_DESC = ['FM', 'LSB', 'USB', 'AM'];

// Menu.cpp menu[]：按压编码器弹出的主菜单（14 项，顺序与固件一致）
// 中文版：专业术语（VFO/AGC/ATTN/AVC）保留原文
// Menu.cpp menu[]：主菜单（14 项），文字与固件数组原文逐字一致
export const MENU_ITEMS = [
  '模式', '波段', '音量', 'VFO A/B', '步进', '搜台', '扫频',
  '记忆', '静噪', '带宽', 'AGC/ATTN', 'AVC', '软静音', '设置',
];

// Menu.cpp settings[]：设置子菜单（24 项），文字与固件数组原文逐字一致。
// 注意第 5 项「定时待机」和第 10 项「编码器」是汉化版新增的，
// 旧版 App 漏了这两项，导致光标与真机整体错位。
export const SETTINGS_ITEMS = [
  '亮度', '日期时间', 'UTC 时区', '休眠定时', '休眠方式', '定时待机',
  '关机定时', '主题', '界面布局', '放大菜单', '编码器', '滚动方向',
  'RDS', 'FM 立体声', 'FM 地区', '校准', 'DSP 补丁', '载入 EiBi',
  '固件升级', 'USB 串口', 'TCP 端口', '蓝牙', 'Wi-Fi', '关于',
];

// 步进档位（steps[][] 的 desc，顺序由细到粗）
export const STEP_LADDER = ['1k', '5k', '9k', '10k', '50k', '100k', '500k'];

// Menu.cpp bands[]：顺序、频率范围与固件完全一致（共 28 个，
// getTotalBands() = ITEM_COUNT(bands)，波段菜单的光标与 B/b 命令都按这个顺序走）
export const BANDS = [
  { name: 'VHF', min: 64000000, max: 108000000 },
  { name: 'ALL', min: 150000, max: 30000000 },
  { name: '11M', min: 25600000, max: 26100000 },
  { name: '13M', min: 21500000, max: 21900000 },
  { name: '15M', min: 18900000, max: 19100000 },
  { name: '16M', min: 17400000, max: 18100000 },
  { name: '19M', min: 15100000, max: 15900000 },
  { name: '22M', min: 13500000, max: 13900000 },
  { name: '25M', min: 11000000, max: 13000000 },
  { name: '31M', min: 9000000, max: 11000000 },
  { name: '41M', min: 7000000, max: 9000000 },
  { name: '49M', min: 5000000, max: 7000000 },
  { name: '60M', min: 4000000, max: 5100000 },
  { name: '75M', min: 3500000, max: 4000000 },
  { name: '90M', min: 3000000, max: 3500000 },
  { name: 'MW3', min: 1700000, max: 3500000 },
  { name: 'MW2', min: 495000, max: 1701000 },
  { name: 'MW1', min: 150000, max: 1800000 },
  { name: '160M', min: 1800000, max: 2000000 },
  { name: '80M', min: 3500000, max: 4000000 },
  { name: '40M', min: 7000000, max: 7300000 },
  { name: '30M', min: 10000000, max: 10200000 },
  { name: '20M', min: 14000000, max: 14400000 },
  { name: '17M', min: 18000000, max: 18200000 },
  { name: '15M', min: 21000000, max: 21500000 },
  { name: '12M', min: 24800000, max: 25000000 },
  { name: '10M', min: 28000000, max: 29700000 },
  { name: 'CB', min: 25000000, max: 28000000 },
];

// Utils.cpp getStrength()：dBuV → S 点
export function getStrength(rssi, mode) {
  if (mode !== 0) {
    if (rssi <= 1) return 1;
    if (rssi <= 2) return 2;
    if (rssi <= 3) return 3;
    if (rssi <= 4) return 4;
    if (rssi <= 10) return 5;
    if (rssi <= 16) return 6;
    if (rssi <= 22) return 7;
    if (rssi <= 28) return 8;
    if (rssi <= 34) return 9;
    if (rssi <= 44) return 10;
    if (rssi <= 54) return 11;
    if (rssi <= 64) return 12;
    if (rssi <= 74) return 13;
    if (rssi <= 84) return 14;
    if (rssi <= 94) return 15;
    if (rssi <= 95) return 16;
    return 17;
  }
  if (rssi <= 1) return 1;
  if (rssi <= 2) return 7;
  if (rssi <= 8) return 8;
  if (rssi <= 14) return 9;
  if (rssi <= 24) return 10;
  if (rssi <= 34) return 11;
  if (rssi <= 44) return 12;
  if (rssi <= 54) return 13;
  if (rssi <= 64) return 14;
  if (rssi <= 74) return 15;
  if (rssi <= 76) return 16;
  return 17;
}

export function bandRange(name) {
  return BANDS.find((b) => b.name === name) || BANDS[1];
}

// ---------- 基础绘图 ----------

// Common.h：FONT_SMALL = font_cn_16，FONT_LARGE = font_cn_24
// 等宽西文 + 中文回退：台名、记忆名现在可以是中文，DejaVu/Consolas 都没有汉字，
// 必须显式列出 Android/iOS 自带的中文字体，否则会画成方框。
const CJK = '"Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Droid Sans Fallback"';
const F_SMALL = `16px "DejaVu Sans Mono", "Menlo", "Consolas", ${CJK}, monospace`;
const F_LARGE = `24px "DejaVu Sans Mono", "Menlo", "Consolas", ${CJK}, monospace`;
const F_BAND = `24px "Helvetica Neue", Arial, ${CJK}, sans-serif`;

function px(v) { return Math.round(v) + 0.5; }

function line(ctx, x1, y1, x2, y2, c) {
  ctx.strokeStyle = c;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (y1 === y2) { ctx.moveTo(x1, px(y1)); ctx.lineTo(x2, px(y1)); }
  else if (x1 === x2) { ctx.moveTo(px(x1), y1); ctx.lineTo(px(x1), y2); }
  else { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
  ctx.stroke();
}

function rect(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function tri(ctx, x1, y1, x2, y2, x3, y3, c) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3);
  ctx.closePath(); ctx.fill();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r, stroke, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// LovyanGFX datum → canvas 对齐
function setFont(ctx, font, color, align, baseline) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = baseline || 'top';
}

// ---------- 七段数码管（Font7：48px，位宽 32px） ----------

const SEG_MAP = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '',
};

function hseg(ctx, x, y, len, t, c) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + t / 2, y - t / 2);
  ctx.lineTo(x + len - t / 2, y - t / 2);
  ctx.lineTo(x + len, y);
  ctx.lineTo(x + len - t / 2, y + t / 2);
  ctx.lineTo(x + t / 2, y + t / 2);
  ctx.closePath();
  ctx.fill();
}

function vseg(ctx, x, y, len, t, c) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + t / 2, y + t / 2);
  ctx.lineTo(x + t / 2, y + len - t / 2);
  ctx.lineTo(x, y + len);
  ctx.lineTo(x - t / 2, y + len - t / 2);
  ctx.lineTo(x - t / 2, y + t / 2);
  ctx.closePath();
  ctx.fill();
}

function seg7char(ctx, x, y0, ch, w, h, color) {
  const segs = SEG_MAP[ch];
  if (segs === undefined) return;
  const t = Math.round(h * 0.11);      // 段厚 ≈ 5px
  const gap = 1.5;
  const top = y0 + t / 2;
  const mid = y0 + h / 2;
  const bot = y0 + h - t / 2;
  const left = x + t / 2;
  const right = x + w - t / 2;
  const hlen = w - t;
  const vlen = h / 2 - t / 2 - gap;

  if (segs.includes('a')) hseg(ctx, left, top, hlen, t, color);
  if (segs.includes('g')) hseg(ctx, left, mid, hlen, t, color);
  if (segs.includes('d')) hseg(ctx, left, bot, hlen, t, color);
  if (segs.includes('f')) vseg(ctx, left, top + t / 2 + gap, vlen, t, color);
  if (segs.includes('b')) vseg(ctx, right, top + t / 2 + gap, vlen, t, color);
  if (segs.includes('e')) vseg(ctx, left, mid + gap, vlen, t, color);
  if (segs.includes('c')) vseg(ctx, right, mid + gap, vlen, t, color);
}

// 右对齐、垂直居中的数字串（等同 MR_DATUM）
// 比原厂 Font7 略小一号，并在字位之间留出 6px 间隙，读数更清楚。
function drawDigits(ctx, str, xRight, midY, color) {
  const h = 40;
  const DIGIT_W = 23;
  const STEP = 29;      // 字位间距 = DIGIT_W + 6px 空隙
  const DOT_W = 12;
  const y0 = midY - h / 2;
  let total = 0;
  for (const c of str) total += c === '.' ? DOT_W : STEP;
  let x = xRight - total;
  for (const c of str) {
    if (c === '.') {
      rect(ctx, x + 3, y0 + h - 7, 6, 6, color);
      x += DOT_W;
    } else {
      seg7char(ctx, x, y0, c, DIGIT_W, h, color);
      x += STEP;
    }
  }
}

// ---------- 各元素（对应固件函数） ----------

function drawSaveIndicator(ctx, th, x, y) {
  rect(ctx, x + 3, y + 2, 3, 5, th.save_icon);
  tri(ctx, x + 1, y + 7, x + 7, y + 7, x + 4, y + 10, th.save_icon);
  line(ctx, x, y + 12, x, y + 13, th.save_icon);
  line(ctx, x, y + 13, x + 8, y + 13, th.save_icon);
  line(ctx, x + 8, y + 13, x + 8, y + 12, th.save_icon);
}

function drawBleIndicator(ctx, th, x, y, connected) {
  const c = connected ? th.rf_icon_conn : th.rf_icon;
  line(ctx, x + 3, y + 1, x + 3, y + 13, c);
  line(ctx, x + 3, y + 1, x + 6, y + 4, c);
  line(ctx, x + 6, y + 4, x, y + 10, c);
  line(ctx, x, y + 4, x + 6, y + 10, c);
  line(ctx, x + 6, y + 10, x + 3, y + 13, c);
}

function drawWiFiIndicator(ctx, th, x, y, connected) {
  const c = connected ? th.rf_icon_conn : th.rf_icon;
  ctx.strokeStyle = c;
  ctx.lineWidth = 3;
  const set = [[14, 13], [9, 8], [4, 3]];
  for (const [rx, ry] of set) {
    ctx.beginPath();
    ctx.ellipse(x, y + 15, rx, ry, 0, (240 * Math.PI) / 180, (300 * Math.PI) / 180);
    ctx.stroke();
  }
}

// 与固件 Battery.cpp 的 BATT_SOC_LEVEL1/2/3 保持一致，改一边记得改另一边。
const BATT_SOC_LEVEL1 = 3.68;
const BATT_SOC_LEVEL2 = 3.78;
const BATT_SOC_LEVEL3 = 3.88;
const BATT_USB_THRESHOLD = 4.3;

function drawBattery(ctx, th, x, y, volts) {
  roundRect(ctx, x, y + 1, 28, 14, 3, th.batt_border, null);
  line(ctx, x + 29, y + 5, x + 29, y + 10, th.batt_border);
  line(ctx, x + 30, y + 6, x + 30, y + 9, th.batt_border);

  setFont(ctx, F_SMALL, th.batt_voltage, 'right', 'top');

  // 还没收到有效电压（未连接 / 旧固件）时不要画 0.00V 和一格红电池
  if (!volts || volts <= 0) {
    ctx.fillText('--', x - 3, y);
    return false;
  }

  // 电压 > 4.3V（USB 供电）→ 画充电闪电
  if (volts > BATT_USB_THRESHOLD) {
    roundRect(ctx, x + 2, y + 3, 24, 10, 2, null, th.batt_charge);
    ctx.fillStyle = th.batt_icon;
    ctx.fillRect(x + 19, y + 7, 10, 2);
    tri(ctx, x + 16, y + 1, x + 13, y + 7, x + 9, y + 8, th.batt_icon);
    tri(ctx, x + 14, y + 7, x + 19, y + 7, x + 12, y + 14, th.batt_icon);
    return false;
  }

  let level = 24;
  let color = th.batt_full;
  if (volts < BATT_SOC_LEVEL1) { level = 6; color = th.batt_low; }
  else if (volts < BATT_SOC_LEVEL2) { level = 12; color = th.batt_full; }
  else if (volts < BATT_SOC_LEVEL3) { level = 18; color = th.batt_full; }

  roundRect(ctx, x + 2, y + 3, level, 10, 2, null, color);
  ctx.fillText(volts.toFixed(2) + 'V', x - 3, y);
  return true;
}

function drawBandAndMode(ctx, th, band, mode, x, y, vfoIdx) {
  // 波段名：Orbitron_Light_24，顶部居中
  setFont(ctx, F_BAND, th.band_text, 'center', 'top');
  ctx.fillText(band, x, y);
  const bandW = ctx.measureText(band).width;

  // 模式：Font2，左上对齐
  setFont(ctx, F_SMALL, th.mode_text, 'left', 'top');
  ctx.fillText(mode, x + bandW / 2 + 12, y + 8);
  const modeW = ctx.measureText(mode).width;

  // 模式外框
  roundRect(ctx, x + bandW / 2 + 8, y + 7, modeW + 8, 17, 4, th.mode_border, null);

  // VFO A/B 小方框
  const vfoX = x + bandW / 2 + modeW + 20;
  roundRect(ctx, vfoX, y + 7, 17, 17, 4, th.mode_border, null);
  setFont(ctx, F_SMALL, th.mode_text, 'center', 'top');
  ctx.fillText(vfoIdx ? 'B' : 'A', vfoX + 9, y + 8);
}

function drawFrequency(ctx, th, st) {
  const x = LAYOUT.FREQ_X;
  const y = LAYOUT.FREQ_Y;
  const ux = LAYOUT.FUNIT_X;
  const uy = LAYOUT.FUNIT_Y;
  const freq = st.freq;

  if (st.mode === 0) {
    // FM：两位小数
    drawDigits(ctx, (freq / 1e6).toFixed(2), x, y, th.freq_text);
    setFont(ctx, F_BAND, th.funit_text, 'left', 'alphabetic');
    ctx.fillText('MHz', ux, uy + 17);
  } else {
    if (st.mode === 1 || st.mode === 2) {
      // SSB：整数 kHz + 三位小数（Font4）
      drawDigits(ctx, String(Math.floor(freq / 1000)).padStart(3, ' '), x, y, th.freq_text);
      setFont(ctx, F_LARGE, th.freq_text, 'left', 'middle');
      ctx.fillText('.' + String(freq % 1000).padStart(3, '0'), 4 + x, 17 + y);
    } else {
      // AM：整数 kHz + ".000"
      drawDigits(ctx, String(Math.floor(freq / 1000)), x, y, th.freq_text);
      setFont(ctx, F_LARGE, th.freq_text, 'left', 'middle');
      ctx.fillText('.000', 4 + x, 17 + y);
    }
    setFont(ctx, F_BAND, th.funit_text, 'left', 'alphabetic');
    ctx.fillText('kHz', ux, uy + 19);
  }
}

// 与固件 drawStationName 一致：小字号（16px）+ 左对齐，超出面板宽度按字截断加省略号
function drawStationName(ctx, th, name, x, y) {
  const LEFT = x - 72 + 6;
  const WIDTH = 152 - 12;

  setFont(ctx, F_SMALL, th.rds_text, 'left', 'top');
  if (ctx.measureText(name).width > WIDTH) {
    const chars = Array.from(name);
    while (chars.length && ctx.measureText(chars.join('') + '…').width > WIDTH) chars.pop();
    name = chars.join('') + '…';
  }

  ctx.fillText(name, LEFT, y + 3);
}

// Menu.cpp drawInfo()：左侧信息框（菜单空闲时）
// 5 行固定项 + 1 行轮播位（关机定时 / 待机定时 / 时钟，只有存在时才占位）
function drawInfo(ctx, th, st, x, y) {
  roundRect(ctx, 1 + x, 1 + y, 86, 110, 4, th.box_border, th.box_bg);

  const rows = [
    ['步进:', st.stepDesc || '5k'],
    ['带宽:', st.bwDesc || '3.0k'],
    st.agcOn
      ? ['AGC:', '开']
      : ['衰减:', String(st.agcNdx).padStart(2, '0')],
    ['音量:', st.muted ? '静音' : String(st.volume)],
    ['AVC:', st.mode === 0 ? 'n/a' : (st.avcDesc && st.avcDesc !== '--' ? st.avcDesc : '--')],
  ];

  // 第 6 行：固件按「关机定时 → 待机定时 → 时钟」轮播，都没有就整行不画
  if (st.offTimer > 0) rows.push(['关机:', String(st.offTimer)]);
  else if (st.standbyTimer > 0) rows.push(['待机:', String(st.standbyTimer)]);
  else if (st.timeText) rows.push([st.timeLabel || '时间:', st.timeText]);

  setFont(ctx, F_SMALL, th.box_text, 'left', 'middle');
  rows.forEach((row, i) => {
    const ry = 64 + y + (i - 3) * 16;
    ctx.fillText(row[0], 6 + x, ry);
    ctx.fillText(row[1], 48 + x, ry);
  });
}

// Menu.cpp drawMenu()/drawCommon()：左侧 86×110 圆角面板，标题 + 分隔线 + 5 行滚动列表
// 几何完全照固件：面板 (1+x,1+y,76+sx,110)，标题 center(40+x+sx/2, 12+y)，
// 分隔线 y=23+y，高亮行 (6+x, 24+y+32, 66+sx, 16)，行文字 y = 64+y+i*16（i=-2..2）
function drawMenuPanel(ctx, th, st, title, items, idx) {
  const x = SB_X, y = SB_Y, sx = LAYOUT.MENU_DX;
  const cx = 40 + x + sx / 2; // 45

  roundRect(ctx, 1 + x, 1 + y, 76 + sx, 110, 4, th.menu_border, th.menu_bg);

  setFont(ctx, F_SMALL, th.menu_hdr, 'center', 'middle');
  ctx.fillText(title, cx, 12 + y);
  line(ctx, 1 + x, 23 + y, 76 + sx + x, 23 + y, th.menu_border);

  // 中间行高亮底
  ctx.fillStyle = th.menu_hl_bg;
  ctx.beginPath();
  roundRectPath(ctx, 6 + x, 24 + y + 32, 66 + sx, 16, 2);
  ctx.fill();

  const count = items.length;
  for (let i = -2; i <= 2; i++) {
    // 固件：项数不足 5 时越界的行直接不画，否则短菜单会重复显示同一项
    if (count < 5 && (idx + i < 0 || idx + i >= count)) continue;
    const item = items[((idx + i) % count + count) % count];
    const sel = i === 0;
    setFont(ctx, F_SMALL, sel ? th.menu_hl_text : th.menu_item, 'center', 'middle');
    ctx.fillText(item, cx, 64 + y + i * 16);
  }
}

// 面板标题（Menu.cpp 各 drawXxx 的标题文字，中文，与固件一致）
export const PANEL_TITLES = {
  bw: '带宽', avc: 'AVC', squelch: '静噪', memory: '记忆',
  seek: '搜台', scan: '扫频', vfo: 'VFO A/B', softmute: '软静音',
  brt: '亮度', datetime: '日期时间', utcoffset: 'UTC 时区',
  sleep: '休眠定时', sleepmode: '休眠方式', offtimer: '关机定时',
  stbytimer: '定时待机', encoder: '编码器',
  theme: '主题', ui: '界面布局', zoom: '放大菜单', scroll: '滚动方向',
  rds: 'RDS', fm_stereo: 'FM 立体声', fm_region: 'FM 地区',
  cal: '校准', dsp: 'DSP 补丁', eibi: '载入 EiBi', updatefw: '固件升级',
  usbmode: 'USB 串口', tcpmode: 'TCP 端口', blemode: '蓝牙',
  wifimode: 'Wi-Fi', about: '关于',
};

// 面板框架（drawCommon）：标题 + 分隔线，无列表高亮
function drawCommonPanel(ctx, th, title) {
  const x = SB_X, y = SB_Y, sx = LAYOUT.MENU_DX;
  roundRect(ctx, 1 + x, 1 + y, 76 + sx, 110, 4, th.menu_border, th.menu_bg);
  setFont(ctx, F_SMALL, th.menu_hdr, 'center', 'middle');
  ctx.fillText(title, 40 + x + sx / 2, 12 + y);
  line(ctx, 1 + x, 23 + y, 76 + sx + x, 23 + y, th.menu_border);
}

// 固件 Menu.cpp 里的枚举文字（与真机逐字一致）
export const LIST_PANELS = {
  ui:        { title: '界面布局', items: ['默认', 'S-Meter'] },
  sleepmode: { title: '休眠方式', items: ['锁定', '解锁', 'CPU 睡眠', 'BLE 待机'] },
  fm_stereo: { title: 'FM 立体声', items: ['自动', '单声道'] },
  usbmode:   { title: 'USB 串口', items: ['关', 'Ad hoc'] },
  tcpmode:   { title: 'TCP 端口', items: ['关', 'Ad hoc'] },
  blemode:   { title: '蓝牙', items: ['关', 'Ad hoc', 'HID', '清除配对'] },
  wifimode:  { title: 'Wi-Fi', items: ['关', '仅 AP', 'AP+连接', '连接', '仅对时'] },
};

// Menu.cpp drawSideBar()：按当前命令切换左侧面板
function drawSideBar(ctx, th, st) {
  const ui = st.ui || 'info';
  if (ui === 'info' || !ui) {
    drawInfo(ctx, th, st, SB_X, SB_Y);
    return;
  }

  // 列表面板：文字与高亮项都由固件回报（st.option）
  const list = LIST_PANELS[ui];
  if (list) {
    drawMenuPanel(ctx, th, st, list.title, list.items, st.option || 0);
    return;
  }

  switch (ui) {
    case 'menu':
      drawMenuPanel(ctx, th, st, '菜单', MENU_ITEMS, st.menuIdx || 0);
      break;

    case 'settings':
      drawMenuPanel(ctx, th, st, '设置', SETTINGS_ITEMS, st.settingsIdx || 0);
      break;

    case 'mode':
      drawMenuPanel(ctx, th, st, '模式', MODE_DESC, st.mode ?? 3);
      break;

    case 'band': {
      const names = BANDS.map((b) => b.name);
      drawMenuPanel(ctx, th, st, '波段', names, Math.max(0, names.indexOf(st.bandName)));
      break;
    }

    case 'step': {
      // 步进档位随模式不同（固件 steps[4]），由调用方传入当前模式的档位表
      const list = (st.stepList && st.stepList.length ? st.stepList : STEP_LADDER);
      const cur = list.findIndex((s) => s.toLowerCase() === String(st.stepDesc || '').toLowerCase());
      drawMenuPanel(ctx, th, st, '步进', list, Math.max(0, cur));
      break;
    }

    case 'volume': {
      // drawVolume()：标题 + 大号音量数字（FONT_DIGITS），静音时数字上画一道斜杠
      drawCommonPanel(ctx, th, '音量');
      const cx = 40 + SB_X + LAYOUT.MENU_DX / 2;
      const cy = 66 + SB_Y;
      setFont(ctx, '32px "DejaVu Sans Mono", "Menlo", monospace', th.menu_param, 'center', 'middle');
      ctx.fillText(String(st.volume ?? 0), cx, cy + 2);
      if (st.muted) {
        // Menu.cpp drawVolume(): for(i=-3;i<4;i++) 画 7 条 1px 斜线
        for (let i = -3; i < 4; i++) {
          line(ctx, cx + 30 + i, cy - 30 + i, cx - 30 + i, cy + 30 + i, th.menu_param);
        }
      }
      break;
    }

    case 'agc': {
      // drawAgc()：AGC On 或两位衰减值
      drawCommonPanel(ctx, th, 'AGC/ATTN');
      const cx = 40 + SB_X + LAYOUT.MENU_DX / 2;
      setFont(ctx, F_SMALL, th.menu_param, 'center', 'middle');
      if (st.agcOn) {
        ctx.fillText('AGC', cx, 48 + SB_Y);
        ctx.fillText('开', cx, 72 + SB_Y);
      } else {
        ctx.fillText(String(st.agcNdx).padStart(2, '0'), cx, 66 + SB_Y);
      }
      break;
    }

    default: {
      // 其余面板（Menu.cpp 各 drawXxx）：标题 + 当前值
      drawCommonPanel(ctx, th, PANEL_TITLES[ui] || '菜单');
      const cx = 40 + SB_X + LAYOUT.MENU_DX / 2;

      // 计时类：大字数值 + 小字单位，为 0 时显示「关」
      // （drawOffTimer / drawStandbyTimer 显示「分」，drawSleep 显示「秒」）
      const timerValue =
        ui === 'offtimer' ? st.offTimer :
        ui === 'stbytimer' ? st.standbyTimer :
        ui === 'sleep' ? st.sleepTimer : undefined;

      if (timerValue !== undefined) {
        setFont(ctx, F_LARGE, th.menu_param, 'center', 'middle');
        if (timerValue) {
          ctx.fillText(String(timerValue), cx, 60 + SB_Y);
          setFont(ctx, F_SMALL, th.menu_param, 'center', 'middle');
          ctx.fillText(ui === 'sleep' ? '秒' : '分', cx, 88 + SB_Y);
        } else {
          ctx.fillText('关', cx, 60 + SB_Y);
        }
        break;
      }

      // 编码器档位（drawEncoder）：大字定位数 + 小字脉冲数
      if (ui === 'encoder' && st.encoderHalfStep !== undefined) {
        setFont(ctx, F_LARGE, th.menu_param, 'center', 'middle');
        ctx.fillText(st.encoderHalfStep ? '30定位' : '20定位', cx, 58 + SB_Y);
        setFont(ctx, F_SMALL, th.menu_item, 'center', 'middle');
        ctx.fillText(st.encoderHalfStep ? '15脉冲' : '20脉冲', cx, 88 + SB_Y);
        break;
      }

      setFont(ctx, F_SMALL, th.menu_param, 'center', 'middle');
      const value =
        ui === 'bw' ? (st.bwDesc || '--') :
        ui === 'avc' ? (st.avcDesc || '--') :
        ui === 'vfo' ? (st.vfoIdx ? 'B' : 'A') :
        ui === 'squelch' ? String(st.volume ?? 0) :
        ui === 'memory' ? String(st.memoryIdx ?? 1).padStart(2, '0') :
        ui === 'brt' ? String(st.backlight ?? '--') :
        ui === 'cal' ? String(st.calibration ?? '--') :
        '--';
      ctx.fillText(String(value), cx, 66 + SB_Y);
      break;
    }
  }
}

function drawSMeter(ctx, th, strength, x, y) {  tri(ctx, x + 1, y + 1, x + 11, y + 1, x + 6, y + 6, th.smeter_icon);
  line(ctx, x + 6, y + 1, x + 6, y + 14, th.smeter_icon);

  for (let i = 0; i < 17; i++) {
    let c = th.smeter_bar_empty;
    if (i < 10 && i < strength) c = th.smeter_bar;
    else if (i < strength) c = th.smeter_bar_plus;
    rect(ctx, 15 + x + i * 4, 2 + y, 2, 12, c);
  }
}

function drawScale(ctx, th, st) {
  tri(ctx, 156, 120, 160, 130, 164, 120, th.scale_pointer);
  line(ctx, 160, 130, 160, 169, th.scale_pointer);

  const step = st.mode === 0 ? 100000 : 10000;
  const slack = 3;
  const freq = st.freq;
  const offset = Math.floor(((freq % step) * 8) / step) + slack * 8;
  let tickFreq = (Math.floor(freq / step) - 20 - slack) * step;
  const range = bandRange(st.bandName);

  setFont(ctx, F_SMALL, th.scale_text, 'center', 'middle');

  for (let i = 0; i < slack + 41 + slack; i++, tickFreq += step) {
    const x = i * 8 - offset;
    if (tickFreq < range.min || tickFreq > range.max) continue;

    const isPtr = i === 20 && (!offset || (!(tickFreq % (5 * step)) && offset === 1));
    const c = isPtr ? th.scale_pointer : th.scale_line;

    if (tickFreq % (10 * step) === 0) {
      line(ctx, x, 169, x, 150, c);
      line(ctx, x + 1, 169, x + 1, 150, c);
      let label;
      if (st.mode === 0) label = (tickFreq / 1e6).toFixed(1);
      else if (tickFreq >= 1000000) label = (tickFreq / 1e6).toFixed(3);
      else label = String(Math.round(tickFreq / 1000));
      ctx.fillStyle = th.scale_text;
      ctx.fillText(label, x, 140);
    } else if (tickFreq % (5 * step) === 0) {
      line(ctx, x, 169, x, 155, c);
      line(ctx, x + 1, 169, x + 1, 155, c);
    } else {
      line(ctx, x, 169, x, 160, c);
    }
  }
}

// ---------- S-Meter 布局（Layout-SMeter.cpp / UI_SMETER） ----------

// Layout-SMeter.cpp getInterpolatedStrength()：RSSI → S 表格数（AM/FM 各一套折线表）
export function getInterpolatedStrength(rssi, mode) {
  const amT = [1, 2, 3, 4, 10, 16, 22, 28, 34, 44, 54, 64, 74, 84, 94, 95, 96];
  const amV = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49];
  const fmT = [1, 2, 8, 14, 24, 34, 44, 54, 64, 74, 76, 77];
  const fmV = [1, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49];

  const isFM = mode === 0;
  const thresholds = isFM ? fmT : amT;
  const values = isFM ? fmV : amV;

  for (let i = 0; i < thresholds.length; i++) {
    if (rssi <= thresholds[i]) {
      if (!i) return values[i];
      const interval = thresholds[i] - thresholds[i - 1];
      if (!interval) return values[i];
      const pos = (rssi - thresholds[i - 1]) / interval;
      return Math.round(values[i - 1] + pos * (values[i] - values[i - 1]));
    }
  }
  return values[values.length - 1];
}

// drawSmallScale()：51..269 的点线，两端圆点，游标实心圆，左右标波段上下限
function drawSmallScale(ctx, th, st, y) {
  const range = bandRange(st.bandName);
  const x0 = 51;
  const x1 = 269;

  for (let i = x0 + 3; i <= x1 - 3; i += 2) {
    rect(ctx, i, y, 1, 1, th.scale_line);
  }
  setFont(ctx, F_SMALL, th.scale_text, 'center', 'middle');
  ctx.strokeStyle = th.scale_line;
  ctx.beginPath();
  ctx.arc(x0, y, 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x1, y, 3, 0, Math.PI * 2);
  ctx.stroke();

  const freq = Math.min(Math.max(st.freq, range.min), range.max);
  const px0 = Math.round(x0 + ((x1 - x0) * (freq - range.min)) / (range.max - range.min || 1));
  ctx.fillStyle = th.scale_pointer;
  ctx.beginPath();
  ctx.arc(px0, y, 3, 0, Math.PI * 2);
  ctx.fill();

  const fmt = (f) => (st.mode === 0 ? (f / 1e6).toFixed(2) : String(Math.round(f / 1000)));
  setFont(ctx, F_SMALL, th.scale_text, 'center', 'middle');
  ctx.fillText(fmt(range.min), x0 - 27, y);
  ctx.fillText(fmt(range.max), x1 + 27, y);
}

// drawAltStereoIndicator()：两个相切圆环
function drawAltStereoIndicator(ctx, th, x, y, stereo) {
  if (!stereo) return;
  ctx.strokeStyle = th.stereo_icon;
  ctx.beginPath();
  ctx.arc(x - 4, y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 4, y, 7, 0, Math.PI * 2);
  ctx.stroke();
}

// drawLargeSMeter()：49 格长条 + S 刻度图例 + 右侧 RSSI 大字
function drawLargeSMeter(ctx, th, rssi, strength, x, y) {
  // 刻度图例（只在奇数位标数字）与连接点线
  setFont(ctx, F_SMALL, th.scale_text, 'center', 'top');
  let lastX = x;
  for (let i = 0; i < 16; i++) {
    if (i % 2) {
      const textX = x + i * 15 - 13;
      let label = null;
      if (i < 10) label = String(i);
      else if (i === 11) label = '+20';
      else if (i === 13) label = '+40';
      else if (i === 15) label = '+60';
      if (label) {
        ctx.fillStyle = th.scale_text;
        ctx.fillText(label, textX, 20 + y);
        const w = ctx.measureText(label).width;
        for (let p = lastX; p < textX - w / 2; p++) {
          if (p & 1) rect(ctx, p, 28 + y, 1, 1, th.scale_line);
        }
        lastX = textX + w / 2;
      }
    }
  }
  for (let p = lastX; p <= x + 15 * 16 + 2; p++) {
    if (p & 1) rect(ctx, p, 28 + y, 1, 1, th.scale_line);
  }

  // "S" 与 RSSI 数值
  setFont(ctx, F_SMALL, th.scale_text, 'left', 'bottom');
  ctx.fillText('S', x - 10, 36 + y);
  setFont(ctx, F_LARGE, th.scale_text, 'right', 'bottom');
  ctx.fillText(String(rssi), x - 15, 40 + y);

  // 49 格条：前 28 格绿色，之后红色，未达部分深灰
  for (let i = 0; i < 49; i++) {
    let c = th.smeter_bar_empty;
    if (i < 28 && i < strength) c = th.smeter_bar;
    else if (i < strength) c = th.smeter_bar_plus;
    rect(ctx, x + i * 5, 11 + y, 3, 10, c);
  }
}

// drawLargeSNMeter()：49 格长条 + "N" 与 SNR 数值
function drawLargeSNMeter(ctx, th, snr, x, y) {
  setFont(ctx, F_SMALL, th.scale_text, 'left', 'bottom');
  ctx.fillText('N', x - 10, 12 + y);
  setFont(ctx, F_LARGE, th.scale_text, 'right', 'bottom');
  ctx.fillText(String(snr), x - 15, 16 + y);

  const bars = Math.floor((snr * 45) / 128);
  for (let i = 0; i < 49; i++) {
    rect(ctx, x + i * 5, y - 1, 3, 10, i < bars ? th.smeter_bar : th.smeter_bar_empty);
  }
}

// ---------- 主入口：等同固件 drawScreen() ----------
// uiLayout 0 = UI_DEFAULT（默认），1 = UI_SMETER（S-Meter 布局）

export function renderScreen(ctx, st) {
  const th = st.theme || THEME_DEFAULT;
  const alt = (st.uiLayout ?? 0) === 1;

  // Draw.h：两种布局的侧边栏原点不同，整块面板跟着平移
  SB_X = alt ? LAYOUT.ALT_MENU_X : LAYOUT.MENU_X;
  SB_Y = alt ? LAYOUT.ALT_MENU_Y : LAYOUT.MENU_Y;

  ctx.save();
  ctx.clearRect(0, 0, SW, SH);
  rect(ctx, 0, 0, SW, SH, th.bg);

  // 休眠：真机直接关屏（drawScreen 里 return）
  if (st.sleep) {
    ctx.restore();
    return;
  }

  if (st.save) drawSaveIndicator(ctx, th, LAYOUT.SAVE_X, LAYOUT.SAVE_Y);
  if (st.ble) drawBleIndicator(ctx, th, LAYOUT.BLE_X, LAYOUT.BLE_Y, st.bleConnected);

  const hasVolt = drawBattery(ctx, th, LAYOUT.BATT_X, LAYOUT.BATT_Y, st.battery ?? 4.02);

  if (st.wifi) {
    drawWiFiIndicator(ctx, th, hasVolt ? LAYOUT.WIFI_X : LAYOUT.BATT_X - 13, LAYOUT.WIFI_Y, true);
  }

  drawBandAndMode(ctx, th, st.bandName || 'SW', MODE_DESC[st.mode ?? 3], LAYOUT.BAND_X, LAYOUT.BAND_Y, st.vfoIdx || 0);

  drawFrequency(ctx, th, st);

  if (st.stationName) drawStationName(ctx, th, st.stationName, LAYOUT.RDS_X, LAYOUT.RDS_Y);

  if (alt) {
    // —— S-Meter 布局（Layout-SMeter.cpp）——
    drawSmallScale(ctx, th, st, 120);
    drawSideBar(ctx, th, st);
    drawAltStereoIndicator(ctx, th, LAYOUT.ALT_STEREO_X, LAYOUT.ALT_STEREO_Y, !!st.stereo);

    // 扫描时固件画频谱图，音频状态下才画双表；状态条优先级更高
    if (st.ui !== 'scan') {
      const rssi = st.rssi ?? 0;
      const snr = st.snr ?? 0;
      drawLargeSNMeter(ctx, th, snr, LAYOUT.ALT_METER_X, LAYOUT.ALT_METER_Y);
      drawLargeSMeter(ctx, th, rssi, getInterpolatedStrength(rssi, st.mode ?? 3), LAYOUT.ALT_METER_X, LAYOUT.ALT_METER_Y);
    }
  } else {
    // —— 默认布局（Layout-Default.cpp）——
    drawSideBar(ctx, th, st);

    drawSMeter(ctx, th, getStrength(st.rssi ?? 0, st.mode ?? 3), LAYOUT.METER_X, LAYOUT.METER_Y);

    // 立体声：把 S 表从中间切开
    if (st.stereo) rect(ctx, 15, 7, 66, 2, th.bg);

    drawScale(ctx, th, st);
  }

  ctx.restore();
}

// 默认演示状态
export const DEFAULT_STATE = {
  freq: 15000000,
  mode: 3,
  bandName: 'SW',
  rssi: 48,
  snr: 22,
  volume: 20,
  agcNdx: 12,
  agcOn: false,
  stepDesc: '5k',
  bwDesc: '3.0k',
  avcDesc: '12dB',
  battery: 4.02,
  ble: true,
  bleConnected: true,
  wifi: false,
  save: false,
  sleep: false,
  stereo: false,
  muted: false,
  stationName: '',
  vfoIdx: 0,
  ui: 'info',      // info 信息框 / menu 主菜单 / volume 音量条 / mode / band / step / bw / agc / settings …
  uiLayout: 0,     // 0 默认布局 / 1 S-Meter 布局（固件 uiLayoutIdx）
  menuIdx: 0,
  settingsIdx: 0,
  timeLabel: '时间:',
  timeText: undefined, // 固件对时后才回报，没有就整行不画
};
