import { useEffect, useRef, useCallback, useState } from 'react';
import {
  renderScreen, DEFAULT_STATE, BANDS, bandRange,
} from '../lib/screenRenderer';
import {
  createModel, onPress, onRotate, onTick, uiKey,
  STEPS_BY_MODE, BW_BY_MODE, MODE_NAMES,
} from '../lib/radioModel';
import { StationTuner, formatFreq } from '../lib/stationTuner';

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
  serial, connected, monitor,
  stations = [], onReadStations, onSaveStation, onDeleteStation,
}) {
  const canvasRef = useRef(null);
  const drawRef = useRef(null);

  // 固件 currentCmd 的状态机（唯一的面板依据，不再靠猜）
  const modelRef = useRef(createModel());
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

  const [lastRx, setLastRx] = useState(0);
  useEffect(() => { if (monitor) setLastRx(Date.now()); }, [monitor]);

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
    const nowD = new Date();

    return {
      ...DEFAULT_STATE,
      freq: fresh('freq') ?? m.frequency ?? 0,
      mode: modeIdx,
      bandName: fresh('band') ?? m.band ?? 'SW',
      rssi: m.rssi || 0,
      snr: m.snr || 0,
      volume: fresh('volume') ?? m.volume ?? 0,
      muted: muteRef.current,
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
      sleep: asleepRef.current,
      ui: uiKey(model),
      menuIdx: model.menuIdx,
      settingsIdx: model.settingsIdx,
      stationName: '',
      timeLabel: '时间',
      timeText: pad2(nowD.getHours()) + ':' + pad2(nowD.getMinutes()),
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
  const wakeUp = () => {
    setSleep(false);
    serial?.sleepOff?.();
    modelRef.current.cmd = 'none';
    draw();
  };

  const toggleSleep = () => {
    if (!connected) return;
    const model = modelRef.current;
    if (asleepRef.current) {
      wakeUp();
    } else {
      setSleep(true);
      serial?.sleepOn?.();
      model.cmd = 'none';
    }
    draw();
  };

  // 长按 = 固件 ats-mini.ino 的 button.isLongPressed 分支：开关屏幕，不改 currentCmd
  const doLongPress = () => {
    if (!connected) return;
    toggleSleep();
  };

  const doClick = (shortPress) => {
    if (!connected) return;
    if (asleepRef.current) { wakeUp(); return; }
    const before = modelRef.current.cmd;
    shortPress ? serial?.encoderShortPress?.() : serial?.encoderPress?.();
    onPress(modelRef.current, shortPress, monRef.current);
    // 固件 clickVolume(shortPress=true) 翻转静音；其它面板短按不会动静音
    if (shortPress && before === 'volume') muteRef.current = !muteRef.current;
    draw();
  };

  // 同步点击：有把握就直接点；没把握先探针再点（保证和真机进同一个面板）
  const syncClick = () => {
    if (!connected) return;
    if (asleepRef.current) { wakeUp(); return; }
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

  const dataFresh = connected && Date.now() - lastRx < 1200;

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
          <button
            onClick={resetPanel}
            className={`absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-digital ${
              dataFresh
                ? 'bg-icom-green/20 text-icom-green'
                : connected
                  ? 'bg-icom-amber/20 text-icom-amber'
                  : 'bg-white/10 text-white/40'
            }`}
            title="点一下把面板复位到信息框"
          >
            {dataFresh ? '● 实时' : connected ? '○ 无数据' : '未连接'}
          </button>
          {asleep && (
            <button
              onClick={toggleSleep}
              className="absolute inset-0 w-full h-full text-[11px] text-white/50"
            >
              已休眠 · 点一下唤醒
            </button>
          )}
        </div>

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
              <span className="text-[8px] text-icom-text-dim">O / o · 长按编码器</span>
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
          <B label={asleep ? '唤醒' : '休眠'} cmd={asleep ? 'o' : 'O'} tone="warn" onClick={toggleSleep} />
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
              onChange={(e) => setName(e.target.value.slice(0, 9))}
              maxLength={9}
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
