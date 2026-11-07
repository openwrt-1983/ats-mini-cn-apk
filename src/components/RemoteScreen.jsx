import { useEffect, useRef, useCallback, useState } from 'react';
import {
  renderScreen, DEFAULT_STATE, BANDS, bandRange,
} from '../lib/screenRenderer';
import {
  createModel, onPress, onRotate, onTick, uiKey,
  STEPS_BY_MODE, BW_BY_MODE, MODE_NAMES,
} from '../lib/radioModel';
import { StationTuner, formatFreq } from '../lib/stationTuner';
import { clampName } from '../lib/nameLimit';

/**
 * 遥控台（单页）：上方 1:1 复刻真机屏幕，下方编码器、功能键、存储电台。
 *
 * 与固件严格对齐的交互（ats-mini.ino / Button.cpp / Menu.cpp / ParserAdhoc.cpp）：
 *   短按键（'E'）   ：NONE→音量；菜单→进子面板；音量→静音切换
 *   长按键          ：开关屏幕（等价按住编码器 >2 秒，固件里不改 currentCmd）
 *   逆/顺时针（r/R）：NONE→调频率；菜单→移光标；子面板→调对应数值
 *   菜单默认高亮第 3 项「音量」（固件 int8_t menuIdx = MENU_VOLUME）
 *   面板 10 秒无操作自动回信息框（ELAPSED_COMMAND）
 *
 * 所有按键都是「点一下就发一条命令」，不靠按住时长猜语义。
 *
 * 数值（频率/音量/波段/模式/步进/带宽/AGC）一律以固件 500ms 状态流为准，
 * 按键瞬间做乐观预测，固件一旦回传就立即让位；另外用「哪个字段在变」反推真机
 * 当前所在面板（固件不回报 currentCmd），发现对不上就自动跟过去。
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (v, n) => ((v % n) + n) % n;
const pad2 = (n) => String(n).padStart(2, '0');

const stepToHz = (s) => {
  const str = String(s || '').trim().toLowerCase();
  const m = str.match(/^([\d.]+)\s*k$/);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  const m2 = str.match(/^([\d.]+)\s*m$/);
  if (m2) return Math.round(parseFloat(m2[1]) * 1e6);
  const m3 = str.match(/^([\d.]+)$/);
  return m3 ? Math.round(parseFloat(m3[1])) : 10000;
};

// 监视器字段 → 面板 cmd：固件只在「对应面板」才会改这个字段，
// 所以监视器里哪个字段在变，真机就停在哪个面板（cmd 不回报，只能这样反推）
const WATCH = [
  ['volume', 'volume'],
  ['frequency', 'freq'],
  ['bandwidth', 'bw'],
  ['agc', 'agc'],
  ['step', 'step'],
  ['mode', 'mode'],
  ['band', 'band'],
];

// 乐观预测的字段 → 监视器里的对应值（用来判断固件是否已经跟上）
const MON_FIELD = {
  freq: (m) => m?.frequency,
  volume: (m) => m?.volume,
  mode: (m) => m?.mode,
  band: (m) => m?.band,
  step: (m) => m?.step,
  bw: (m) => m?.bandwidth,
  agcOn: (m) => (m ? parseInt(m.agc, 10) === 0 : undefined),
};

export default function RemoteScreen({
  serial, connected, monitor, firmwareUi,
  stations = [], onReadStations, onSaveStation, onDeleteStation,
  resetRef,
}) {
  const canvasRef = useRef(null);
  const drawRef = useRef(null);

  // 固件 currentCmd 的状态机（唯一的面板依据，不再靠猜）
  const modelRef = useRef(createModel());
  // 固件回报的界面状态。有它就以它为准；旧固件不推，才退回本地推断。
  const firmwareUiRef = useRef(null);
  // 乐观预测层：field -> { v, base, t }
  const optimRef = useRef({});
  const monRef = useRef({});

  // 最近一次由 App 自己发起的字段改动时间：用来区分「我改的」和「真机自己在变」
  const dirtyRef = useRef({});
  const touchField = (f) => { dirtyRef.current[f] = Date.now(); };

  // 最近一次发送「不改变面板」的直接命令（B/M/V/S/W/A/L/I）的时间
  const lastDirectRef = useRef(0);
  const touchDirect = () => {
    lastDirectRef.current = Date.now();
    dirtyRef.current.freq = Date.now();
    dirtyRef.current.volume = Date.now();
  };

  // 静音状态：监视器里没有这个字段，只能本地记（固件 clickVolume 短按翻转 MUTE_MAIN）
  const muteRef = useRef(false);

  // ---- 同步点击（探针对齐）----
  // 固件不回报 currentCmd，App 只能预测。当预测没把握时（刚连接/发生过自愈/接近 10s 超时），
  // 点「点击」先发一格旋转当探针：看真机哪个数值在动，就知道它停在哪个面板，
  // 把面板对齐、数值恢复后再发 'e' —— 保证进的一定是同一个面板。
  const connectAtRef = useRef(0);
  const probeRef = useRef(null);
  const lastHealRef = useRef(0);
  const forceProbeRef = useRef(false);
  const [probing, setProbing] = useState(false);

  const asleepRef = useRef(false);
  const [asleep, setAsleep] = useState(false);
  const setSleep = (v) => { asleepRef.current = v; setAsleep(v); };
  // 旧固件不认识 'Z' 时，用它把请求退回 'O'
  const standbyFallbackRef = useRef(null);
  // 旧固件不认识 'y' 时，用它把唤醒退回 'o'
  const wakeFallbackRef = useRef(null);

  // 「● 同步 / ○ 无数据」状态灯已经移到顶部连接条，由父组件按 lastMonitorTs 计算

  // ---------- 存储电台 ----------
  const [selIdx, setSelIdx] = useState(0);
  const [slot, setSlot] = useState(1);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const tunerRef = useRef(null);
  if (!tunerRef.current) {
    tunerRef.current = new StationTuner(null, { onStatus: (t) => setStatus(t) });
  }
  useEffect(() => { tunerRef.current.serial = serial; }, [serial]);
  useEffect(() => { tunerRef.current.handleMonitor(monitor); }, [monitor]);
  useEffect(() => () => tunerRef.current?.cancel(), []);

  const curStation = stations[selIdx] || null;

  const jumpTo = (idx) => {
    if (!stations.length) return;
    const i = wrap(idx, stations.length);
    const st = stations[i];
    setSelIdx(i);
    setSlot(st.slot);
    setName(st.name || '');
    if (!connected) return;
    modelRef.current.cmd = 'none';      // 跳台后真机回信息框
    tunerRef.current.start({ band: st.band, mode: st.mode, freqHz: st.freq });
  };

  const doSave = async () => {
    if (!connected) { setStatus('未连接'); return; }
    try {
      setStatus(await onSaveStation?.(slot, name.trim()) || '');
    } catch (e) {
      setStatus('保存失败：' + (e?.message || e));
    }
  };

  const doDelete = async () => {
    if (!connected) { setStatus('未连接'); return; }
    try {
      setStatus(await onDeleteStation?.(slot) || '');
    } catch (e) {
      setStatus('删除失败：' + (e?.message || e));
    }
  };

  // ---------- 屏幕状态 ----------
  const buildState = useCallback(() => {
    const m = monRef.current || {};
    const model = modelRef.current;
    const o = optimRef.current;
    const now = Date.now();
    const fresh = (f) => (o[f] && now - o[f].t < 1500 ? o[f].v : undefined);

    const modeName = fresh('mode') ?? m.mode ?? 'AM';
    const modeIdx = MODE_NAMES.indexOf(modeName) >= 0 ? MODE_NAMES.indexOf(modeName) : 3;
    const modeKey = MODE_NAMES[modeIdx];
    // 固件回报的界面状态（新固件才有）。有它就不必再靠「哪个数值在变」反推面板。
    const fu = firmwareUiRef.current;

    return {
      ...DEFAULT_STATE,
      freq: fresh('freq') ?? m.frequency ?? 0,
      mode: modeIdx,
      bandName: fresh('band') ?? m.band ?? 'SW',
      rssi: m.rssi || 0,
      snr: m.snr || 0,
      volume: fresh('volume') ?? m.volume ?? 0,
      muted: fu ? fu.muted : muteRef.current,
      agcNdx: parseInt(m.agc, 10) || 0,
      agcOn: fresh('agcOn') ?? parseInt(m.agc, 10) === 0,
      stepDesc: fresh('step') ?? m.step ?? '5k',
      stepList: STEPS_BY_MODE[modeKey] || STEPS_BY_MODE.AM,
      bwDesc: fresh('bw') ?? m.bandwidth ?? '3.0k',
      avcDesc: '--',
      battery: m.voltage || 0,
      calibration: m.calibration ?? 0,
      ble: true,
      bleConnected: !!connected,
      sleep: fu ? fu.sleep : asleepRef.current,
      // 以下六项只有固件回报时才存在，面板照实显示真机的数值
      backlight: fu ? fu.backlight : undefined,
      sleepTimer: fu ? fu.sleepTimer : undefined,
      standbyTimer: fu ? fu.standbyTimer : undefined,
      offTimer: fu ? fu.offTimer : undefined,
      encoderHalfStep: fu ? fu.encoderHalfStep : undefined,
      ui: fu ? fu.ui : uiKey(model),
      // 界面布局：0 默认 / 1 S-Meter（固件 uiLayoutIdx）
      uiLayout: fu ? (fu.layout || 0) : 0,
      option: fu ? (fu.option || 0) : 0,
      vfoIdx: fu ? (fu.vfo || 0) : 0,
      stereo: fu ? !!fu.stereo : false,
      menuIdx: fu ? fu.menuIdx : model.menuIdx,
      settingsIdx: fu ? fu.settingsIdx : model.settingsIdx,
      stationName: fu ? (fu.stationName || '') : '',
      // 第 6 行是固件的轮播位：没有定时器、没有对时就不显示。
      // 不能拿手机时间顶上，否则真机空着 App 却多一行。
      timeLabel: '时间:',
      timeText: fu ? fu.clockText : undefined,
    };
  }, [connected]);

  const draw = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = 2;
    if (cvs.width !== 320 * dpr) {
      cvs.width = 320 * dpr;
      cvs.height = 170 * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderScreen(ctx, buildState());
  }, [buildState]);
  drawRef.current = draw;

  // 固件回报的界面状态：屏幕照它渲染，本地状态机跟着它走。
  // 这是「和真机屏幕一模一样」的唯一依据 —— 不再靠「哪个数值在变」去猜面板。
  // 旧固件不推这些字段，firmwareUi 恒为 null，下面整段跳过。
  useEffect(() => {
    firmwareUiRef.current = firmwareUi || null;
    if (!firmwareUi) return;

    const model = modelRef.current;
    // 固件用 CMD_NONE 表示信息框，本地状态机用 'none'，这里做个翻译
    model.cmd = firmwareUi.ui === 'info' ? 'none' : firmwareUi.ui;
    model.menuIdx = firmwareUi.menuIdx;
    model.settingsIdx = firmwareUi.settingsIdx;
    model.lastAct = Date.now();

    // 有固件实测状态就不需要探针了
    probeRef.current = null;
    setProbing(false);
    setSleep(!!firmwareUi.sleep);
    muteRef.current = !!firmwareUi.muted;
    draw();
  }, [firmwareUi, draw]);

  // 乐观预测：先改屏，等固件回传后自动让位
  const mark = (field, value) => {
    optimRef.current[field] = {
      v: value,
      base: MON_FIELD[field]?.(monRef.current),
      t: Date.now(),
    };
    touchField(field);
  };

  // 监视器到帧：撤销已跟上的乐观值 + 用「哪个字段在变」反推真机所在面板
  useEffect(() => {
    const prev = monRef.current || {};
    monRef.current = monitor || {};

    for (const [k, o] of Object.entries(optimRef.current)) {
      const cur = MON_FIELD[k]?.(monRef.current);
      if (cur !== undefined && cur !== o.base) delete optimRef.current[k];
    }

    const model = modelRef.current;
    const now = Date.now();

    // 固件已经回报界面状态，面板归属不必（也不该）再由「哪个字段在变」反推，
    // 否则会和固件给的 currentCmd 互相打架。直接重画即可。
    if (firmwareUiRef.current) { draw(); return; }

    // ---- 探针观察期：只判断真机在哪个面板，不做别的 ----
    if (probeRef.current) {
      const probe = probeRef.current;
      let hit = null;
      for (const [key, f] of WATCH) {
        const a = prev[key];
        const b = monRef.current[key];
        if (a !== undefined && b !== undefined && String(a) !== String(b)) { hit = f; break; }
      }
      if (hit) {
        probeRef.current = null;
        // 把探针转动的那一格恢复回去
        if (hit === 'freq') serial?.setFrequency?.(probe.f0);
        else if (hit === 'volume') serial?.volumeDown?.();
        else if (hit === 'band') serial?.prevBand?.();
        else if (hit === 'mode') serial?.prevMode?.();
        else if (hit === 'step') serial?.prevStep?.();
        else if (hit === 'bw') serial?.prevBandwidth?.();
        else if (hit === 'agc') serial?.agcDown?.();
        // 面板对齐到真机真实位置，然后才发点击
        model.cmd = hit === 'freq' ? 'none' : hit;
        model.lastAct = Date.now();
        setProbing(false);
        setTimeout(() => doClick(false), 150);
        return;
      }
      return;   // 还没观察到变化，等下一帧或 700ms 兜底
    }

    // 不是我这边刚发命令造成的字段变化（>900ms 冷却），说明是真机在动 → 可以据此判面板
    const observed = (f) => now - (dirtyRef.current[f] || 0) > 900 && now - lastDirectRef.current > 900;
    const changed = [];
    for (const [key, f] of WATCH) {
      const a = prev[key];
      const b = monRef.current[key];
      if (a !== undefined && b !== undefined && String(a) !== String(b) && observed(f)) changed.push(f);
    }

    // 只有一个字段在变时最可信；同时多个字段变多半是切波段连带的（模式/步进一起改），不据此判面板
    if (changed.length && (changed.length === 1 || changed[0] === 'volume' || changed[0] === 'freq')) {
      const f = changed[0];
      const target = f === 'freq' ? 'none' : f;
      const keep = f === 'freq' && (model.cmd === 'seek' || model.cmd === 'scan');
      if (model.cmd !== target && !keep) {
        model.cmd = target;
        lastHealRef.current = now;
      }
    }

    draw();
  }, [monitor, draw, serial]);

  // 250ms 心跳：面板超时回落、时间走字、乐观值过期
  useEffect(() => {
    const t = setInterval(() => {
      onTick(modelRef.current);
      draw();
    }, 250);
    return () => clearInterval(t);
  }, [draw]);

  // 连接建立：记住时刻并强制下一次「点击」先探针对齐（真机可能还停在上次的菜单里）
  // 断开连接后回到信息框
  useEffect(() => {
    if (connected) {
      connectAtRef.current = Date.now();
      forceProbeRef.current = true;
      return;
    }
    if (!connected) {
      modelRef.current.cmd = 'none';
      optimRef.current = {};
      muteRef.current = false;
      setSleep(false);
      draw();
    }
  }, [connected, draw]);

  // ---------- 编码器：旋转 ----------
  const encStep = (dir) => {
    if (!connected || asleepRef.current) return;   // 休眠中旋钮无效（固件同样忽略）
    dir > 0 ? serial?.rotateUp?.() : serial?.rotateDown?.();

    const model = modelRef.current;
    const st = buildState();
    const modeKey = MODE_NAMES[st.mode] || 'AM';
    const cmd = model.cmd;

    onRotate(model, dir, monRef.current);

    switch (cmd) {
      case 'none': {
        const range = bandRange(st.bandName);
        mark('freq', clamp((st.freq || 0) + dir * stepToHz(st.stepDesc), range.min, range.max));
        break;
      }
      case 'volume':
        mark('volume', clamp((st.volume || 0) + dir, 0, 63));
        break;
      case 'mode':
        if (st.mode === 0) break;   // FM 下固件 doMode 直接 return
        mark('mode', MODE_NAMES[((st.mode - 1 + dir + 3) % 3) + 1]);
        break;
      case 'band': {
        const names = BANDS.map((b) => b.name);
        const i = names.indexOf(st.bandName);
        if (i >= 0) mark('band', names[wrap(i + dir, names.length)]);
        break;
      }
      case 'step': {
        const list = STEPS_BY_MODE[modeKey] || [];
        const i = list.findIndex((s) => s.toLowerCase() === String(st.stepDesc).toLowerCase());
        if (i >= 0) mark('step', list[wrap(i + dir, list.length)]);
        break;
      }
      case 'bw': {
        const list = BW_BY_MODE[modeKey] || [];
        const i = list.findIndex((s) => s.toLowerCase() === String(st.bwDesc).toLowerCase());
        if (i >= 0) mark('bw', list[wrap(i + dir, list.length)]);
        break;
      }
      case 'agc':
        mark('agcOn', !st.agcOn);   // agcIdx 0 = AGC 开，往上为衰减
        break;
      default:
        break;
    }

    draw();
  };

  const repeatRef = useRef({ t1: null, t2: null });
  const startRepeat = (fn) => (e) => {
    e.preventDefault();
    // 捕获指针：手指滑出按钮也继续算这个键，不会中途断掉或误判给别的键
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (!connected || asleepRef.current) return;
    fn();
    stopRepeat();
    repeatRef.current.t1 = setTimeout(() => {
      repeatRef.current.t2 = setInterval(fn, 90);
    }, 380);
  };
  const stopRepeat = () => {
    clearTimeout(repeatRef.current.t1);
    clearInterval(repeatRef.current.t2);
    repeatRef.current.t1 = null;
    repeatRef.current.t2 = null;
  };
  useEffect(() => () => stopRepeat(), []);

  // ---------- 编码器：按压拆成三个语义固定的键 ----------
  // 固件 ParserAdhoc.cpp：'e' = handleClick(false) 点击、'E' = handleClick(true) 短按，
  // 长按 (>LONG_PRESS_INTERVAL 2s) 在 ats-mini.ino 里是独立的开关屏幕分支。
  // 以前靠「按住多久」推断，手指一滑就会多判一次，导致点一下变两下、面板跳级。
  // 唤醒：屏幕亮起来 + 把『休眠方式』切回 CPU 睡眠（SLEEP_LIGHT）。
  //
  // 为什么唤醒也要动休眠方式：'Z' 在旧固件里会把休眠方式持久化成「BLE 待机」，新固件
  // 已改成一次性（standbyForced），但旧固件仍在用。所以每次醒来都发 'y'：固件先
  // sleepOn(false) 正确唤醒（按当前档恢复功放/收音/SI4732），再把休眠方式存成 CPU 睡眠。
  // CPU 睡眠 = 只熄屏，收音机继续放，这正是真机长按的常规行为。
  const wakeUp = () => {
    clearTimeout(standbyFallbackRef.current);
    standbyFallbackRef.current = null;
    clearTimeout(wakeFallbackRef.current);
    wakeFallbackRef.current = null;
    setSleep(false);
    setStatus('');
    if (serial?.wakeLight) {
      serial.wakeLight();
      // 旧固件不认 'y'，屏不会亮。800ms 没等到 sleep=0 就补发 'o' 兜底。
      wakeFallbackRef.current = setTimeout(() => {
        wakeFallbackRef.current = null;
        const fu = firmwareUiRef.current;
        if (fu && !fu.sleep) return; // 已确认醒来
        serial?.sleepOff?.();
      }, 800);
    } else {
      serial?.sleepOff?.();
    }
    modelRef.current.cmd = 'none';
    draw();
  };

  // 单击 / 「BLE 待机」按钮 = 进 / 出蓝牙待机。
  //
  // 固件里「蓝牙待机」到底是什么（见 Utils.cpp 的 bleStandbyEnter + sleepOn）：
  //   sleepModeIdx == SLEEP_BLE_KEEPALIVE 时熄屏，然后
  //     用户静音（若原本没静音）→ 功放 EN 拉低 → 停 Wi-Fi → SI4732 powerDown()
  //     → CPU 降到 80MHz → 广播间隔放慢到 500ms
  //   也就是：屏幕黑、喇叭不响、收音机芯片断电、只剩 BLE 在跑，'o' 才能叫醒。
  // 这一档平时要靠「设置 → 休眠方式 → BLE 待机」再熄屏才能进；出厂默认是
  // SLEEP_LOCKED，直接发 'O' 只会黑屏、收音机照响 —— 这正是之前点待机「不对」的原因。
  //
  // 所以进待机发 'Z'：固件 standbyEnter() 抬起 standbyForced，强制走一遍
  // bleStandbyEnter()，不管设置里是哪一档都能真正断电静音；只作用当次，不改设置。
  // 唤醒走 wakeUp()（'y'）。
  const toggleSleep = () => {
    if (!connected) return;
    const model = modelRef.current;
    if (asleepRef.current) {
      wakeUp();
      return;
    }
    setSleep(true);
    setStatus('');
    if (serial?.bleStandby) serial.bleStandby();
    else serial?.sleepOn?.();
    model.cmd = 'none';
    draw();
    // 固件每 500ms 推一次状态，正常 0.6 秒内就能看到 sleep=1。
    // 1.4 秒还没确认说明收音机跑的不是配套固件（旧固件不认 'Z'）：
    //   · 完全不回报界面 → 退回 'O'，按固件里的『休眠方式』走，至少行为与真机一致
    //   · 会回报界面但没进待机 → 不接受假状态，退回未休眠并说明原因
    clearTimeout(standbyFallbackRef.current);
    standbyFallbackRef.current = setTimeout(() => {
      standbyFallbackRef.current = null;
      const fu = firmwareUiRef.current;
      if (fu && fu.sleep) return;
      if (fu) {
        setSleep(false);
        setStatus('固件没确认待机（睡眠方式可能被锁定），请再点一次或长按熄屏');
        draw();
        return;
      }
      // 旧固件：'Z' 不认识，只能退回 'O'（按固件里的休眠方式熄屏）。
      // 出厂默认 SLEEP_LOCKED 下这一步只黑屏，收音机照响 —— 如实说明，不要假装成功。
      serial?.sleepOn?.();
      setStatus('固件未配套：只熄了屏，收音机还在响。刷 ats-mini.ino.merged.bin 后才能真正待机');
    }, 900);
  };

  // 长按 = 真机长按编码器：按『休眠方式』设置熄屏/亮屏，不做强制待机
  const doLongPress = () => {
    if (!connected) return;
    if (asleepRef.current) { wakeUp(); return; }
    setSleep(true);
    serial?.sleepOn?.();
    modelRef.current.cmd = 'none';
    draw();
  };

  const doClick = (shortPress) => {
    if (!connected) return;
    if (asleepRef.current) { wakeUp(); return; }
    shortPress ? serial?.encoderShortPress?.() : serial?.encoderPress?.();
    if (!firmwareUiRef.current) {
      // 旧固件不回报界面，只能本地预测；等状态流回来再纠正
      const before = modelRef.current.cmd;
      onPress(modelRef.current, shortPress, monRef.current);
      // 固件 clickVolume(shortPress=true) 翻转静音；其它面板短按不会动静音
      if (shortPress && before === 'volume') muteRef.current = !muteRef.current;
    }
    // 新固件会在下一条状态流里带回真实 currentCmd，本地不做猜测，避免跳级
    draw();
  };

  // 同步点击：有把握就直接点；没把握先探针再点（保证和真机进同一个面板）
  const syncClick = () => {
    if (!connected) return;
    if (asleepRef.current) { wakeUp(); return; }
    // 固件已经回报真实界面，点在哪个面板就是哪个面板，探针完全不需要
    if (firmwareUiRef.current) { doClick(false); return; }
    const model = modelRef.current;
    const now = Date.now();
    const recent = now - connectAtRef.current > 3000
      && now - (model.lastAct || 0) < 8500;                  // 10s 超时前留出余量
    const healed = now - lastHealRef.current < 5000;
    if (!forceProbeRef.current && recent && !healed) { doClick(false); return; }
    forceProbeRef.current = false;
    const f0 = monRef.current?.frequency;
    if (f0 === undefined) { doClick(false); return; }
    setProbing(true);
    probeRef.current = { f0, start: now };
    serial?.rotateUp?.();                                   // 探针：一格旋转
    onRotate(model, 1, monRef.current);                     // 若真在菜单，光标同步 +1
    // 700ms 兜底：真机没动静（多半在菜单/设置面板，旋转只移光标）就按模型直接点
    setTimeout(() => {
      if (probeRef.current) {
        probeRef.current = null;
        setProbing(false);
        doClick(false);
      }
    }, 700);
  };

  // ---------- 功能键（固件各自的单字符命令，不改变 currentCmd） ----------
  const bandStep = (dir) => {
    if (!connected) return;
    touchDirect();
    dir > 0 ? serial?.nextBand?.() : serial?.prevBand?.();
    const st = buildState();
    const names = BANDS.map((b) => b.name);
    const i = names.indexOf(st.bandName);
    if (i >= 0) mark('band', names[wrap(i + dir, names.length)]);
    draw();
  };

  const modeStep = (dir) => {
    if (!connected) return;
    touchDirect();
    dir > 0 ? serial?.nextMode?.() : serial?.prevMode?.();
    const st = buildState();
    if (st.mode === 0) return;   // FM 不接受切换
    mark('mode', MODE_NAMES[((st.mode - 1 + dir + 3) % 3) + 1]);
    draw();
  };

  const volumeStep = (dir) => {
    if (!connected) return;
    touchDirect();
    dir > 0 ? serial?.volumeUp?.() : serial?.volumeDown?.();
    mark('volume', clamp((buildState().volume || 0) + dir, 0, 63));
    draw();
  };

  const stepFieldStep = (dir) => {
    if (!connected) return;
    touchDirect();
    dir > 0 ? serial?.nextStep?.() : serial?.prevStep?.();
    const st = buildState();
    const list = st.stepList || [];
    const i = list.findIndex((s) => s.toLowerCase() === String(st.stepDesc).toLowerCase());
    if (i >= 0) mark('step', list[wrap(i + dir, list.length)]);
    draw();
  };

  const agcStep = (dir) => {
    if (!connected) return;
    touchDirect();
    dir > 0 ? serial?.agcUp?.() : serial?.agcDown?.();
    mark('agcOn', !buildState().agcOn);
    draw();
  };

  // 面板复位（真机本来也会 10 秒后自动回信息框，这里给个手动兜底）
  const resetPanel = () => {
    modelRef.current.cmd = 'none';
    forceProbeRef.current = true;   // 下一次「点击」先探针对齐
    draw();
  };

  // 顶部连接条上的「同步」按钮要能点这里，所以把函数交给父组件
  useEffect(() => {
    if (resetRef) resetRef.current = resetPanel;
  });

  const B = ({ label, cmd, onClick, tone }) => (
    <button
      onClick={() => connected && onClick()}
      disabled={!connected}
      className={`h-11 rounded-md border text-[11px] leading-none flex flex-col items-center justify-center gap-0.5
        active:translate-y-px transition disabled:opacity-30
        ${tone === 'acc'
          ? 'bg-icom-accent/15 border-icom-accent/50 text-icom-green'
          : tone === 'warn'
            ? 'bg-icom-amber/15 border-icom-amber/40 text-icom-amber'
            : 'bg-icom-panel border-icom-accent/30 text-icom-text'}`}
    >
      <span>{label}</span>
      <span className="text-[8px] text-icom-text-dim">{cmd}</span>
    </button>
  );

  // 收音机跑的固件是否配套（会回报 15 项之后那批界面字段）。
  // 不配套时：面板内容、光标位置、休眠状态全都只能由 App 猜，屏幕必然和真机不同步。
  // 与其让用户以为是 App 的 bug，不如直接在界面上说清楚。
  const paired = !!firmwareUi;
  const fieldCount = monitor?.fields || 0;

  return (
    <div className="h-full flex flex-col landscape:flex-row gap-2 overflow-hidden">

      {/* ===== 左列：真机屏幕 + 编码器 ===== */}
      <div className="flex flex-col gap-2 shrink-0 landscape:flex-1 landscape:min-w-0 landscape:justify-center">
        <div className="rounded-md overflow-hidden border-2 border-black bg-black shadow-icom-strong relative">
          <div className="w-full portrait:max-h-[30vh] landscape:max-h-[46vh] flex justify-center" style={{ aspectRatio: '320 / 170' }}>
            <canvas
              ref={canvasRef}
              width={640}
              height={340}
              className="block w-full h-full object-contain"
            />
          </div>
          {asleep && (
            <button
              onClick={toggleSleep}
              className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-1 text-[11px] text-white/50"
            >
              <span>{paired ? '已休眠 · 点一下唤醒' : '屏已熄 · 点一下唤醒'}</span>
              {!paired && (
                <span className="text-[9px] text-icom-amber px-4 leading-snug">
                  固件未配套：只是黑了屏，收音机还在响
                </span>
              )}
            </button>
          )}
        </div>

        {/* ===== 固件配套检查：不配套就把话说明白，别让用户以为屏幕不同步是 App 的问题 ===== */}
        {connected && !paired && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-red-300">
            收音机固件未配套（收到 {fieldCount} 项状态，配套固件应 ≥ 26 项）。面板文字和光标只能由 App 推算，
            所以菜单、设置、模式这些一定会和真机对不上；「BLE 待机」也只是熄屏，不会静音断电。
            <div className="mt-0.5 text-red-200/80">
              把 <span className="font-digital">ats-mini.ino.merged.bin</span> 刷到 0x0 地址，重连后这里会自动消失。
            </div>
          </div>
        )}

        {/* ===== 编码器：旋转左右两个 + 中间「点击」；下方「短按 / 长按」 ===== */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_78px_1fr] gap-2">
            <button
              onPointerDown={startRepeat(() => encStep(-1))}
              onPointerUp={stopRepeat}
              onPointerCancel={stopRepeat}
              disabled={!connected || asleep}
              style={{ touchAction: 'none' }}
              className="h-16 rounded-lg border border-icom-accent/40 bg-icom-panel text-icom-text
                flex flex-col items-center justify-center gap-0.5 active:translate-y-0.5 transition disabled:opacity-30"
            >
              <span className="text-lg leading-none">◄</span>
              <span className="text-[10px]">逆时针</span>
              <span className="text-[8px] text-icom-text-dim">r</span>
            </button>

            <button
              onClick={syncClick}
              disabled={!connected}
              style={{ touchAction: 'none' }}
              className="h-16 rounded-full border border-icom-accent/50 bg-gradient-to-br from-icom-accent/25 to-icom-bg
                text-icom-text text-[11px] flex flex-col items-center justify-center gap-0.5
                shadow-icom-strong active:translate-y-0.5 transition disabled:opacity-30"
            >
              <span>{probing ? '对齐中…' : '点击'}</span>
              <span className="text-[8px] text-icom-text-dim">e · 菜单/确定</span>
            </button>

            <button
              onPointerDown={startRepeat(() => encStep(1))}
              onPointerUp={stopRepeat}
              onPointerCancel={stopRepeat}
              disabled={!connected || asleep}
              style={{ touchAction: 'none' }}
              className="h-16 rounded-lg border border-icom-accent/40 bg-icom-panel text-icom-text
                flex flex-col items-center justify-center gap-0.5 active:translate-y-0.5 transition disabled:opacity-30"
            >
              <span className="text-lg leading-none">►</span>
              <span className="text-[10px]">顺时针</span>
              <span className="text-[8px] text-icom-text-dim">R</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => doClick(true)}
              disabled={!connected}
              className="h-11 rounded-lg border border-icom-amber/50 bg-icom-amber/10 text-icom-amber
                text-[12px] flex flex-col items-center justify-center gap-0.5
                active:translate-y-0.5 transition disabled:opacity-30"
            >
              <span>短按</span>
              <span className="text-[8px] text-icom-text-dim">E · 音量/静音</span>
            </button>
            <button
              onClick={doLongPress}
              disabled={!connected}
              className="h-11 rounded-lg border border-icom-accent/50 bg-icom-accent/10 text-icom-green
                text-[12px] flex flex-col items-center justify-center gap-0.5
                active:translate-y-0.5 transition disabled:opacity-30"
            >
              <span>{asleep ? '长按唤醒' : '长按熄屏'}</span>
              <span className="text-[8px] text-icom-text-dim">O 熄屏 / y 唤醒·切CPU睡眠</span>
            </button>
          </div>
        </div>
      </div>

      {/* ===== 右列：功能键 + 存储电台（竖屏时在下方，横屏时在右侧） ===== */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 landscape:w-[46%] landscape:flex-none pb-2">
        {/* ===== 功能键（固件各自的单字符命令，不改变 currentCmd） ===== */}
        <div className="grid grid-cols-4 gap-1.5 shrink-0">
          <B label="波段 ◄" cmd="b" onClick={() => bandStep(-1)} />
          <B label="波段 ►" cmd="B" onClick={() => bandStep(1)} />
          <B label="模式 ◄" cmd="m" onClick={() => modeStep(-1)} />
          <B label="模式 ►" cmd="M" onClick={() => modeStep(1)} />

          <B label="音量 ◄" cmd="v" onClick={() => volumeStep(-1)} />
          <B label="音量 ►" cmd="V" onClick={() => volumeStep(1)} />
          <B label="带宽 ◄" cmd="w" onClick={() => serial?.prevBandwidth?.()} />
          <B label="带宽 ►" cmd="W" onClick={() => serial?.nextBandwidth?.()} />

          <B label="步进 ◄" cmd="s" onClick={() => stepFieldStep(-1)} />
          <B label="步进 ►" cmd="S" onClick={() => stepFieldStep(1)} />
          <B label="AGC ◄" cmd="a" onClick={() => agcStep(-1)} />
          <B label="AGC ►" cmd="A" onClick={() => agcStep(1)} />

          <B label="背光 ◄" cmd="l" onClick={() => serial?.backlightDown?.()} />
          <B label="背光 ►" cmd="L" onClick={() => serial?.backlightUp?.()} />
          <B label="校准 +" cmd="I" tone="acc" onClick={() => serial?.calibrationUp?.()} />
          <B label={asleep ? '唤醒' : 'BLE 待机'} cmd={asleep ? 'y' : 'Z'} tone="warn" onClick={toggleSleep} />
        </div>

        {/* 存储电台：上一个 / 下一个 / 保存 / 删除 */}
        <div className="rounded-md border border-icom-accent/30 bg-icom-panel p-2 shrink-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-digital text-icom-text">存储电台</span>
            <span className="text-[9px] text-icom-text-dim font-digital">
              {stations.length ? `${selIdx + 1}/${stations.length}` : '未读取'}
            </span>
            <button
              onClick={() => connected && onReadStations?.()}
              disabled={!connected}
              className="ml-auto px-2 py-0.5 rounded border border-icom-accent/40 text-[10px] font-digital
                text-icom-accent active:translate-y-px disabled:opacity-30"
            >
              读取
            </button>
          </div>

          <div className="grid grid-cols-[42px_1fr_42px] gap-1.5">
            <button
              onClick={() => jumpTo(selIdx - 1)}
              disabled={!connected || !stations.length}
              className="rounded border border-icom-accent/40 bg-icom-display text-icom-accent text-sm
                active:translate-y-px disabled:opacity-30"
            >
              ◄
            </button>
            <button
              onClick={() => jumpTo(selIdx)}
              disabled={!connected || !stations.length}
              className="rounded border border-icom-accent/30 bg-icom-display px-2 py-1 flex flex-col items-center
                justify-center leading-tight active:translate-y-px disabled:opacity-40"
            >
              {curStation ? (
                <>
                  <span className="text-[9px] text-icom-text-dim font-digital">
                    {`${pad2(curStation.slot)} · ${curStation.band} · ${curStation.mode}`}
                  </span>
                  <span className="text-[13px] font-digital text-icom-green truncate max-w-full">
                    {curStation.name || formatFreq(curStation.freq, curStation.mode)}
                  </span>
                  {curStation.name && (
                    <span className="text-[9px] text-icom-text font-digital">
                      {formatFreq(curStation.freq, curStation.mode)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-[10px] text-icom-text-dim">点「读取」载入收音机里的电台</span>
              )}
            </button>
            <button
              onClick={() => jumpTo(selIdx + 1)}
              disabled={!connected || !stations.length}
              className="rounded border border-icom-accent/40 bg-icom-display text-icom-accent text-sm
                active:translate-y-px disabled:opacity-30"
            >
              ►
            </button>
          </div>

          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[9px] text-icom-text-dim font-digital shrink-0">槽位</span>
            <button
              onClick={() => setSlot((s) => (s <= 1 ? 99 : s - 1))}
              disabled={!connected}
              className="w-6 h-6 rounded border border-icom-accent/40 text-[10px] text-icom-accent
                active:translate-y-px disabled:opacity-30"
            >
              ◄
            </button>
            <span className="w-6 text-center text-[12px] font-digital text-icom-green">{pad2(slot)}</span>
            <button
              onClick={() => setSlot((s) => (s >= 99 ? 1 : s + 1))}
              disabled={!connected}
              className="w-6 h-6 rounded border border-icom-accent/40 text-[10px] text-icom-accent
                active:translate-y-px disabled:opacity-30"
            >
              ►
            </button>
            <input
              value={name}
              onChange={(e) => setName(clampName(e.target.value))}
              maxLength={24}
              placeholder="名称(可空)"
              className="flex-1 min-w-0 bg-icom-display text-icom-text text-[11px] px-2 py-1 rounded
                border border-icom-accent/30 focus:border-icom-accent focus:outline-none"
            />
          </div>

          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <button
              onClick={doSave}
              disabled={!connected}
              className="h-8 rounded border border-icom-accent/50 bg-icom-accent/15 text-icom-green
                text-[11px] font-digital active:translate-y-px disabled:opacity-30"
            >
              保存当前电台
            </button>
            <button
              onClick={doDelete}
              disabled={!connected}
              className="h-8 rounded border border-red-600/50 bg-red-600/10 text-red-400
                text-[11px] font-digital active:translate-y-px disabled:opacity-30"
            >
              删除该槽
            </button>
          </div>

          {status && (
            <div className="mt-1 text-[9px] font-digital text-icom-text-dim leading-tight">{status}</div>
          )}
        </div>
      </div>
    </div>
  );
}
