/**
 * 电台自动跳转引擎（Station Tuner）v3
 *
 * 核心思路（v2 的"按波段名盲切"在蓝牙下会来回拉锯，v3 彻底放弃）：
 *   1. 波段阶段的目标不是"切到存储槽记录的那个波段名"，而是
 *      "切到任何一个频率范围覆盖目标频率的波段"。因为最后一步
 *      用固件 F 命令直达频率，只要当前波段盖得住目标频率即可。
 *      ALL 波段（150kHz~30MHz）覆盖几乎所有 AM 台，多数情况
 *      一步都不用切，直接进频率阶段。
 *   2. 每次监视器回报后重新计算步数和方向（允许换方向），
 *      不再"盲发一次后固定向上单步纠正"——那是 v2 来回跳的根因。
 *   3. 模式阶段：切波段后固件自动套用该波段默认模式；若还需调整，
 *      按 doMode 的三档循环（LSB→USB→AM，跳过 FM）精确计算步数。
 *      注意固件在 FM 模式下忽略 M 命令：若此时波段已覆盖目标频率
 *      （罕见，如用户在覆盖波段里手动调成 FM），先跳出再跳回，
 *      让固件重置为非 FM 默认模式。
 *   4. 频率阶段：F<Hz> 命令一条直达，未确认命中自动重发（最多 3 次）。
 */

// ===== 固件波段表（与 Menu.cpp bands[] 一致，含频率范围 Hz）=====
const BAND_TABLE = [
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

// 固件 doMode 的循环顺序：AM/LSB/USB 三档循环（FM 档被跳过且 FM 模式下 M 命令无效）
const MODE_CYCLE = ['LSB', 'USB', 'AM'];

const BURST_INTERVAL_MS = 60;   // 连发命令间隔
const TOTAL_TIMEOUT_MS = 25000; // 整个跳转流程的超时
const MAX_BAND_ROUNDS = 12;     // 波段阶段最多重算轮数
const MAX_MODE_STEPS = 8;       // 模式阶段最多单步数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目标频率换算到收音机可落点的网格频率（FM 10kHz 网格，其余 1kHz 网格） */
export function landableFreq(freqHz, mode) {
  const unit = mode === 'FM' ? 10000 : 1000;
  return Math.floor((Number(freqHz) || 0) / unit) * unit;
}

/** 频率格式化显示：FM 显示 MHz，AM/SSB 显示 kHz */
export function formatFreq(freqHz, mode) {
  const f = Number(freqHz) || 0;
  if (!f) return '---';
  if (mode === 'FM') return `${(f / 1000000).toFixed(2)} MHz`;
  return `${(f / 1000).toFixed(f % 1000 ? 2 : 0)} kHz`;
}

/** 按名称解析波段索引（重名波段靠频率范围区分）；找不到返回 null */
function resolveBandIdx(bandName, freqHz) {
  if (!bandName) return null;
  const f = Number(freqHz) || 0;
  let byNameOnly = null;
  for (let i = 0; i < BAND_TABLE.length; i++) {
    const b = BAND_TABLE[i];
    if (b.name !== bandName) continue;
    if (f >= b.min && f <= b.max) return i;
    if (byNameOnly === null) byNameOnly = i;
  }
  return byNameOnly;
}

/**
 * 计算从当前波段到"最近一个覆盖目标频率的波段"的步数与方向。
 * 与 v2 不同：目标不要求波段名一致，只要求范围覆盖目标频率。
 * 返回 { dir: 'B'|'b', n, targetIdx }；当前波段无法解析时返回 null。
 */
function pressesToCover(curBand, curFreq, targetFreq) {
  const N = BAND_TABLE.length;
  const c = resolveBandIdx(curBand, curFreq);
  if (c === null) return null;
  if (targetFreq >= BAND_TABLE[c].min && targetFreq <= BAND_TABLE[c].max) {
    return { dir: 'B', n: 0, targetIdx: c };
  }
  let best = null;
  for (let j = 0; j < N; j++) {
    const b = BAND_TABLE[j];
    if (targetFreq < b.min || targetFreq > b.max) continue;
    const up = (j - c + N) % N;
    const down = (c - j + N) % N;
    const plan = up <= down ? { dir: 'B', n: up } : { dir: 'b', n: down };
    if (!best || plan.n < best.n) best = { ...plan, targetIdx: j };
  }
  return best;
}

/** 计算模式切换的精确步数（非 FM 三档循环）；涉及 FM 时返回 null */
function modePresses(curMode, targetMode) {
  if (curMode === targetMode) return { n: 0 };
  if (curMode === 'FM' || targetMode === 'FM') return null;
  const c = MODE_CYCLE.indexOf(curMode);
  const t = MODE_CYCLE.indexOf(targetMode);
  if (c < 0 || t < 0) return null;
  return { n: (t - c + MODE_CYCLE.length) % MODE_CYCLE.length };
}

export class StationTuner {
  /**
   * @param {object} serial SerialConnection / BleConnection 实例（接口一致）
   * @param {object} hooks { onStatus(text), onDone(info) }
   */
  constructor(serial, hooks = {}) {
    this.serial = serial;
    this.onStatus = hooks.onStatus || (() => {});
    this.onDone = hooks.onDone || (() => {});
    this.active = false;
  }

  /** 开始跳转到目标电台 { band, mode, freqHz } */
  start(target) {
    if (!target || !target.mode || !target.freqHz) return;
    this.cancel();
    this.active = true;
    this.target = {
      band: target.band || null,
      mode: target.mode,
      freqHz: landableFreq(target.freqHz, target.mode),
    };
    this.phase = 'band';
    this.busy = false;       // 连发进行中（期间忽略监视器回调）
    this.settleUntil = 0;    // 连发后等监视器追平的时间点
    this.bandRounds = 0;     // 波段阶段重算轮数
    this.modeSteps = 0;      // 模式阶段已按次数
    this.freqTries = 0;
    this.escapingFm = false; // 正在跳出 FM
    this.freqSentAt = 0;
    this.deadline = Date.now() + TOTAL_TIMEOUT_MS;
    this._status(`正在跳转到 ${formatFreq(this.target.freqHz, this.target.mode)}…`);
  }

  cancel() {
    this.active = false;
    this.phase = null;
    this.busy = false;
  }

  /** 每次监视器数据更新时调用（约每 500ms 一次） */
  handleMonitor(md) {
    if (!this.active || !md || this.busy) return;
    if (!md.mode || !md.band || md.mode === '---' || md.band === '---') return;
    if (Date.now() > this.deadline) {
      return this._fail('跳转超时，请检查收音机连接后重试');
    }

    switch (this.phase) {
      case 'band': return this._phaseBand(md);
      case 'mode': return this._phaseMode(md);
      case 'freq': return this._phaseFreq(md);
      default: break;
    }
  }

  // ---------- 波段阶段：目标 = 当前波段范围覆盖目标频率 ----------

  _phaseBand(md) {
    const plan = pressesToCover(md.band, md.frequency, this.target.freqHz);

    // 当前波段已覆盖目标频率（多数 AM 台在这一步直接通过，不用切波段）
    if (plan && plan.n === 0) {
      this._enterModePhase(md);
      return;
    }

    if (this.escapingFm) {
      // 正在跳出 FM：等到模式不再是 FM（切波段会重置模式）
      if (md.mode !== 'FM') {
        this.escapingFm = false;
        // 波段已被改变，重新评估（不重置轮数上限以免死循环）
      } else {
        return; // 等下一次回报
      }
    }

    // 无法解析当前波段（名字不在表里）：单步盲走碰运气
    if (!plan) {
      this.bandRounds += 1;
      if (this.bandRounds > MAX_BAND_ROUNDS) {
        return this._fail(`无法切换波段（当前 ${md.band}），请重试`);
      }
      this.settleUntil = Date.now() + 900;
      this.serial.nextBand();
      return;
    }

    if (Date.now() < this.settleUntil) return;

    this.bandRounds += 1;
    if (this.bandRounds > MAX_BAND_ROUNDS) {
      return this._fail(`无法切换到覆盖 ${formatFreq(this.target.freqHz, this.target.mode)} 的波段（当前 ${md.band}）`);
    }

    // 每轮重新计算方向和步数（蓝牙丢包后自动纠偏，允许换方向——v2 来回跳的修复点）
    this._burst(plan.dir, plan.n, `正在切换波段…（${plan.n} 步）`);
  }

  // ---------- 模式阶段 ----------

  _enterModePhase(md) {
    this.phase = 'mode';
    this.modeSteps = 0;
    this.settleUntil = 0;
    if (md.mode === this.target.mode) {
      this._enterFreqPhase();
    } else {
      this._status(`波段就绪，正在切换模式到 ${this.target.mode}…`);
    }
  }

  _phaseMode(md) {
    if (md.mode === this.target.mode) {
      this._enterFreqPhase();
      return;
    }

    // FM 模式下固件忽略 M 命令：先跳出当前波段再跳回，让固件重置为非 FM 模式
    if (md.mode === 'FM' && this.target.mode !== 'FM' && !this.escapingFm) {
      this.escapingFm = true;
      this.phase = 'band';
      this._status('正在脱离 FM 模式…');
      this.serial.nextBand();
      return;
    }

    if (Date.now() < this.settleUntil) return;

    const plan = modePresses(md.mode, this.target.mode);
    if (!plan) {
      return this._fail(`无法切换到模式 ${this.target.mode}（当前 ${md.mode}）`);
    }
    if (plan.n === 0) return; // 等下一次回报确认

    this.modeSteps += plan.n;
    if (this.modeSteps > MAX_MODE_STEPS) {
      return this._fail(`无法切换到模式 ${this.target.mode}（当前 ${md.mode}）`);
    }
    // 连发 M 命令（模式循环固定 3 档，短连发可靠）
    this._burst('M', plan.n, `正在切换模式到 ${this.target.mode}…`);
  }

  // ---------- 频率阶段 ----------

  _enterFreqPhase() {
    this.phase = 'freq';
    this.freqTries = 0;
    this.settleUntil = 0;
    this._status(`正在调谐到 ${formatFreq(this.target.freqHz, this.target.mode)}…`);
  }

  _freqMatched(md) {
    const got = md.frequency || 0;
    const t = this.target.freqHz;
    if (this.target.mode === 'FM') {
      return Math.abs(got - t) < 5000; // FM 监视器按 10kHz 网格回报
    }
    if (this.target.mode === 'AM') {
      return Math.abs(got - t) <= 500;  // AM 按 1kHz 网格
    }
    // SSB（LSB/USB）：部分固件版本会带 BFO 偏移，放宽到 ±1.5kHz
    return Math.abs(got - t) <= 1500;
  }

  _phaseFreq(md) {
    if (this._freqMatched(md)) {
      return this._done(md);
    }

    if (Date.now() < this.settleUntil) return;

    this.freqTries += 1;
    if (this.freqTries >= 4) {
      return this._fail(`频率未确认（收音机当前 ${formatFreq(md.frequency, md.mode)}）`);
    }
    // 重发 F 命令（可能上一条被蓝牙丢包）
    this.settleUntil = Date.now() + 2000;
    this.serial.setFrequency(this.target.freqHz);
  }

  // ---------- 工具 ----------

  /** 连发命令：期间置 busy，监视器回调不生效；结束后等监视器追平再校验 */
  async _burst(dir, n, statusText) {
    this.busy = true;
    this._status(statusText);
    for (let i = 0; i < n; i++) {
      if (!this.active) { this.busy = false; return; }
      try {
        if (dir === 'B') await this.serial.nextBand();
        else if (dir === 'b') await this.serial.prevBand();
        else if (dir === 'M') await this.serial.nextMode();
      } catch (e) { /* 单条失败继续，下一轮监视器校验兜底 */ }
      await sleep(BURST_INTERVAL_MS);
    }
    this.busy = false;
    // 连发结束 + 缓冲，让监视器把最新状态报上来
    this.settleUntil = Date.now() + n * BURST_INTERVAL_MS + 1100;
  }

  _status(text) {
    this.onStatus(text);
  }

  _fail(msg) {
    this.active = false;
    this.phase = null;
    this.busy = false;
    this.onStatus(`✗ ${msg}`);
    this.onDone({ ok: false, message: msg });
  }

  _done(md) {
    const freq = md ? md.frequency : this.target.freqHz;
    const txt = `已跳转到 ${formatFreq(freq, md && md.mode)} ${md ? md.band : ''} ${md ? md.mode : ''}`.trim();
    this.active = false;
    this.phase = null;
    this.busy = false;
    this.onStatus(txt);
    this.onDone({ ok: true, message: txt, frequency: freq });
  }
}
