import { useState, useEffect, useRef } from 'react';
import { SerialConnection } from '../lib/SerialConnection';
import { BleConnection, getSavedBleDevice } from '../lib/BleConnection';
import RemoteScreen from './RemoteScreen';

/**
 * 单页版：遥控台（复刻屏幕 + 编码器按键 + 连接 + 存储电台）全部在一屏内，
 * 原来的「收音机 / 存储器 / 工具 / 调试 / 关于」等页签已移除。
 */
export default function ATSController() {
  const serialRef = useRef(null);
  const bleRef = useRef(null);
  const [connType, setConnType] = useState('ble'); // 'usb' | 'ble'
  // 后台回调（visibilitychange）里要读到最新连接方式，用 ref 转一手
  const connTypeRef = useRef('ble');
  useEffect(() => { connTypeRef.current = connType; }, [connType]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  // 上次连接过的设备（启动时用于直连 + 顶部提示）
  const [savedDevice, setSavedDevice] = useState(() => getSavedBleDevice());
  const [deviceName, setDeviceName] = useState('');
  const [baudRate] = useState(115200);
  const [monitorData, setMonitorData] = useState({
    firmware: '---',
    frequency: 0,
    band: 'FM',
    mode: 'FM',
    rssi: 0,
    snr: 0,
    voltage: 0,
    step: 10,
    bandwidth: 'AUTO',
    agc: 'AUTO',
    volume: 50,
    backlight: 5,
    calibration: 0,
    sleep: false,
    memory: '---',
  });
  const [error, setError] = useState(null);
  // 固件回报的界面状态（currentCmd / 光标 / 休眠 / 定时器等）。旧固件恒为 null。
  const [firmwareUi, setFirmwareUi] = useState(null);
  // 收音机里存储的电台（'#槽位,波段,频率,模式[,名称]' 行）
  const [stations, setStations] = useState([]);

  // 监视器看门狗状态
  const lastMonitorTs = useRef(0);
  const lastResendTs = useRef(0);
  const resendCount = useRef(0);
  // 本次连接建立的时刻，以及是否已经尝试过「重建连接」这种重手段
  const connectedAt = useRef(0);
  const healTried = useRef(false);
  // 自动重建连接的次数：一台上电周期内最多一次，避免「重连-零数据-再重连」死循环
  const healCount = useRef(0);
  // 用户主动点了「断开」——之后不要自动连回去
  const userDisconnected = useRef(false);

  // 顶部状态灯「● 同步 / ○ 无数据」：由 RemoteScreen 挂上来的面板复位函数
  const panelResetRef = useRef(null);
  const [dataFresh, setDataFresh] = useState(false);

  // 状态流 1.2 秒没来新数据就判为「无数据」。只在真假翻转时才改状态，
  // 避免每 400ms 触发一次整棵组件树重绘（手机上会掉帧）。
  useEffect(() => {
    if (!connected) { setDataFresh(false); return undefined; }
    const id = setInterval(() => {
      const fresh = Date.now() - lastMonitorTs.current < 1200;
      setDataFresh((prev) => (prev === fresh ? prev : fresh));
    }, 400);
    return () => clearInterval(id);
  }, [connected]);

  useEffect(() => {
    serialRef.current = new SerialConnection();
    bleRef.current = new BleConnection();

    for (const conn of [serialRef.current, bleRef.current]) {
      conn.onMonitorData((data) => {
        lastMonitorTs.current = Date.now();
        resendCount.current = 0;
        setMonitorData(data);
      });

      // 固件回报的界面状态：屏幕镜像与面板归属都以它为准
      conn.onUiData((ui) => {
        lastMonitorTs.current = Date.now();
        resendCount.current = 0;
        setFirmwareUi(ui);
      });

      conn.onRawData((data) => {
        const line = String(data).trim();

        // 固件报错行（例如 Error: No such band）直接提示出来
        if (/^Error:/i.test(line)) {
          setError(line);
          setTimeout(() => setError(null), 4000);
          return;
        }

        const m = line.match(/^#(\d{1,2}),([A-Za-z0-9]+),(\d+),(AM|FM|LSB|USB)(?:,(.*))?$/);
        if (!m) return;
        const station = {
          slot: parseInt(m[1], 10),
          band: m[2],
          freq: parseInt(m[3], 10),
          mode: m[4],
          name: (m[5] || '').trim(),
        };
        if (!station.freq) return;
        setStations((prev) => {
          const idx = prev.findIndex((s) => s.slot === station.slot);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = station;
            return copy;
          }
          return [...prev, station].sort((a, b) => a.slot - b.slot);
        });
      });

      conn.onError((err) => {
        setError(err.message);
        setTimeout(() => setError(null), 5000);
      });

      conn.onConnectionChange((status) => {
        setConnected(status);
        if (!status) {
          setDeviceName('');
          setStations([]);
          setFirmwareUi(null);
          return;
        }
        // 本次连接起点：看门狗据此判断「连上多久还一条状态都没收到」
        connectedAt.current = Date.now();
        // 已经自动重建过一次就不再重来，否则会陷入 重连→零数据→重连 的循环
        healTried.current = healCount.current >= 1;
        lastMonitorTs.current = 0;
        lastResendTs.current = 0;
        resendCount.current = 0;

        // 开状态流不能只赌一枪：链路刚就绪时写入偶尔会被丢，
        // 连发三次（立即 / 0.7s / 2s），命令本身幂等，多发无害。
        const arm = () => {
          for (const c of [serialRef.current, bleRef.current]) {
            if (c && c.connected) c.ensureMonitor();
          }
        };
        arm();
        setTimeout(arm, 700);
        setTimeout(arm, 2000);

        // 连接后读一次存储电台（不依赖 connType，谁连上就开谁）
        setTimeout(() => {
          const c = serialRef.current && serialRef.current.connected ? serialRef.current : bleRef.current;
          if (c && c.connected) c.showMemorySlots();
        }, 1600);
      });
    }

    // 启动自动重连：只认上次连接过的设备（deviceId 存在本地），不弹系统选择器。
    // 冷启动时蓝牙栈往往还没就绪，第一枪容易失败，所以退避重试 3 次。
    const saved = getSavedBleDevice();
    if (saved) {
      setSavedDevice(saved);
      (async () => {
        setAutoConnecting(true);
        try {
          // 两轮足够：connect() 内部本身还会重试一次。再多会让「自动连接…」
          // 在按钮上挂十几秒，用户会以为卡死了。
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const ok = await bleRef.current.connect({ onlySaved: true, silent: true });
            if (ok) {
              setDeviceName(bleRef.current.deviceName || saved.name || 'ATS-Mini');
              setSavedDevice(getSavedBleDevice());
              return;
            }
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
          }
          console.log('[ATS] 自动重连失败，等待用户手动连接');
        } catch { /* 静默 */ } finally {
          setAutoConnecting(false);
        }
      })();
    }

    // 从后台切回前台时补一次静默重连：安卓常在后台回收 BLE 连接，
    // 但用户主动点过「断开」的话就不打扰。
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (userDisconnected.current || connTypeRef.current !== 'ble') return;
      if (bleRef.current && bleRef.current.connected) return;
      if (!getSavedBleDevice()) return;
      console.log('[ATS] 回到前台，尝试静默重连');
      bleRef.current.connect({ onlySaved: true, silent: true }).then((ok) => {
        if (ok) setDeviceName(bleRef.current.deviceName || 'ATS-Mini');
      }).catch(() => { /* 静默 */ });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (serialRef.current && serialRef.current.connected) serialRef.current.disconnect();
      if (bleRef.current && bleRef.current.connected) bleRef.current.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监视器看门狗：超过 0.9 秒没有状态回报就把监视器重新打开（原来要等 6 秒）
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      const conn = connType === 'ble' ? bleRef.current : serialRef.current;
      if (!conn || !conn.connected) return;
      // 息屏休眠中一律不补发：固件收到任何字节都会 sleepOn(false)，
      // 保活命令会立刻把收音机唤醒，休眠就永远停不住。
      if (conn.sleeping) return;
      const now = Date.now();

      // 连上了却一条状态都收不到：先靠 ensureMonitor 补发，6 秒还是零行
      // 说明 GATT/CCCD 建得不干净（或写入通道坏），重建一次连接。
      // 只对 BLE 做——USB 重建要用户重新授权，不能自作主张。
      if (!lastMonitorTs.current && connectedAt.current && now - connectedAt.current > 6000) {
        if (connType === 'ble' && bleRef.current && !healTried.current) {
          healTried.current = true;
          healCount.current += 1;
          console.warn('[ATS] 已连接但 6 秒零状态，重建连接');
          (async () => {
            try {
              await bleRef.current.disconnect();
              await new Promise((r) => setTimeout(r, 800));
              const ok = await bleRef.current.connect({ onlySaved: true, silent: true });
              if (!ok) {
                setError('连接已建立但收不到数据，自动重连也失败了，请点「连接」手动重连');
                setTimeout(() => setError(null), 6000);
              }
            } catch { /* ignore */ }
          })();
        } else if (healTried.current) {
          setError('连接已建立但收不到数据：请点「断开」，等两秒再点「连接」');
          setTimeout(() => setError(null), 8000);
        }
        return;
      }

      if (now - lastMonitorTs.current < 900) return;
      // 补发要有间隔，避免把固件的『开关』式监视器来回翻
      const gap = resendCount.current >= 3 ? 3000 : 1000;
      if (now - lastResendTs.current < gap) return;
      lastResendTs.current = now;
      resendCount.current += 1;
      // ensureMonitor：认识 'g' 就发幂等的 'g'；零行时也用 'g' 先探，
      // 只有确认是老固件才退回 't'。不会像旧实现那样把状态流翻来翻去。
      conn.ensureMonitor();
    }, 250);
    return () => clearInterval(timer);
  }, [connected, connType]);

  const activeConn = () => (connType === 'ble' ? bleRef.current : serialRef.current);

  const handleConnect = async () => {
    if (connecting) return;
    if (connected) {
      // 用户明确要断开：之后从后台回来不要自作主张连回去
      userDisconnected.current = true;
      await activeConn()?.disconnect();
      return;
    }
    userDisconnected.current = false;
    healCount.current = 0;   // 手动连接 = 重新开始计数

    if (connType === 'usb' && !SerialConnection.isSupported()) {
      setError('当前环境不支持 USB 串口，请改用蓝牙连接。');
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      if (connType === 'ble') {
        // 优先直连上次连过的设备（免弹选择器），连不上再弹系统选择器
        const ok = await bleRef.current.connect({ preferSaved: true });
        if (ok) {
          setDeviceName(bleRef.current.deviceName || 'ATS-Mini');
          setSavedDevice(getSavedBleDevice());
        }
      } else {
        await serialRef.current.connect(baudRate);
      }
    } catch (e) {
      setError(e?.message || '连接失败');
    } finally {
      setConnecting(false);
    }
  };

  // 读存储电台
  const handleReadStations = () => {
    if (!connected) return;
    setStations([]);
    activeConn()?.showMemorySlots();
  };

  // 保存当前收听的频率到指定槽位（固件 '#槽位,波段,频率,模式[,名称]'）
  const handleSaveStation = async (slot, name) => {
    if (!connected) return '未连接';
    const band = monitorData.band;
    const mode = monitorData.mode;
    const freq = Math.round(monitorData.frequency || 0);
    if (!freq) return '当前没有有效频率';
    await activeConn()?.setMemorySlot(slot, band, freq, mode, name || undefined);
    setTimeout(handleReadStations, 700);
    return `已保存到 ${String(slot).padStart(2, '0')} 槽`;
  };

  // 删除指定槽位（固件以频率 0 表示清空）
  const handleDeleteStation = async (slot) => {
    if (!connected) return '未连接';
    const saved = stations.find((s) => s.slot === slot);
    const band = saved?.band || monitorData.band;
    const mode = saved?.mode || monitorData.mode;
    if (!saved) return '该槽位没有电台';
    await activeConn()?.deleteStation(slot, band, mode);
    setTimeout(handleReadStations, 700);
    return `已删除 ${String(slot).padStart(2, '0')} 槽`;
  };

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden bg-icom-bg">
      <div className="max-w-3xl landscape:max-w-5xl mx-auto w-full flex flex-col h-full p-2 gap-1.5">
        {/* 连接条：方式切换 + 连接/断开 */}
        <div className="shrink-0 bg-icom-panel rounded-lg px-2 py-1.5 border border-icom-accent/30 flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-icom-green led-indicator' : 'bg-icom-red'}`}
          />
          <div className="min-w-0 flex-1 flex items-center gap-1.5">
            <span className="text-[11px] font-digital text-icom-text truncate leading-tight">
              {connected
                ? `${connType === 'ble' ? '蓝牙' : 'USB'} · ${deviceName || 'ATS-Mini'}`
                : autoConnecting
                  ? `正在自动连接 ${savedDevice?.name || '上次设备'}…`
                  : savedDevice
                    ? `未连接 · 上次 ${savedDevice.name || 'ATS-Mini'}`
                    : 'ATS MINI 未连接'}
            </span>
            <button
              onClick={() => panelResetRef.current?.()}
              disabled={!connected}
              className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-digital transition-colors disabled:opacity-60 ${
                dataFresh
                  ? firmwareUi
                    ? 'bg-icom-green/20 text-icom-green'
                    : 'bg-icom-amber/20 text-icom-amber'
                  : connected
                    ? 'bg-icom-amber/20 text-icom-amber'
                    : 'bg-white/10 text-white/40'
              }`}
              title="点一下把面板复位到信息框"
            >
              {dataFresh ? (firmwareUi ? '● 同步' : '● 实时') : connected ? '○ 无数据' : '未连接'}
            </button>
          </div>

          {/* 连接方式：USB / 蓝牙 */}
          <div className="flex rounded overflow-hidden border border-icom-accent/40 shrink-0">
            {[
              ['usb', 'USB'],
              ['ble', '蓝牙'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setConnType(k)}
                disabled={connected || connecting}
                className={`px-2 py-1 text-[10px] font-digital transition-colors disabled:opacity-60 ${
                  connType === k ? 'bg-icom-accent text-icom-bg' : 'bg-icom-display text-icom-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={handleConnect}
            disabled={connecting || autoConnecting}
            className={`px-3 py-1.5 rounded text-[11px] font-digital shrink-0 transition-colors ${
              connected
                ? 'bg-red-600/80 text-white'
                : 'bg-icom-accent text-icom-bg'
            } disabled:opacity-60`}
          >
            {autoConnecting ? '自动连接…' : connecting ? '连接中…' : connected ? '断开' : '连接'}
          </button>
        </div>

        {error && (
          <div className="shrink-0 bg-red-600/20 border border-red-600/70 text-red-400 px-2 py-1 rounded text-[10px] font-digital">
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0">
          <RemoteScreen
            serial={activeConn()}
            connected={connected}
            connType={connType}
            monitor={monitorData}
            firmwareUi={firmwareUi}
            stations={stations}
            onReadStations={handleReadStations}
            onSaveStation={handleSaveStation}
            onDeleteStation={handleDeleteStation}
            resetRef={panelResetRef}
          />
        </div>
      </div>
    </div>
  );
}
