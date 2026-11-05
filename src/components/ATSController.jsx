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
  // 收音机里存储的电台（'#槽位,波段,频率,模式[,名称]' 行）
  const [stations, setStations] = useState([]);

  // 监视器看门狗状态
  const lastMonitorTs = useRef(0);
  const lastResendTs = useRef(0);
  const resendCount = useRef(0);

  useEffect(() => {
    serialRef.current = new SerialConnection();
    bleRef.current = new BleConnection();

    for (const conn of [serialRef.current, bleRef.current]) {
      conn.onMonitorData((data) => {
        lastMonitorTs.current = Date.now();
        resendCount.current = 0;
        setMonitorData(data);
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
        } else {
          // 连接后先开监视器，再读一次存储电台（不依赖 connType，谁连上就开谁）
          setTimeout(() => {
            for (const c of [serialRef.current, bleRef.current]) {
              if (c && c.connected) c.ensureMonitor();
            }
          }, 500);
          setTimeout(() => {
            if (serialRef.current && serialRef.current.connected) serialRef.current.showMemorySlots();
            else if (bleRef.current && bleRef.current.connected) bleRef.current.showMemorySlots();
          }, 1500);
        }
      });
    }

    // 启动自动重连：只认上次连接过的设备，不弹系统选择器，失败静默（用户可手动点"连接"）
    const saved = getSavedBleDevice();
    if (saved) {
      setSavedDevice(saved);
      (async () => {
        setAutoConnecting(true);
        try {
          const ok = await bleRef.current.connect({ onlySaved: true, silent: true });
          if (ok) setDeviceName(bleRef.current.deviceName || saved.name || 'ATS-Mini');
        } catch { /* 静默 */ } finally {
          setAutoConnecting(false);
        }
      })();
    }

    return () => {
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
      const now = Date.now();
      if (now - lastMonitorTs.current < 900) return;
      // 连发重试要有间隔，避免把固件的『开关』式监视器来回翻
      const gap = resendCount.current >= 3 ? 3000 : 1000;
      if (now - lastResendTs.current < gap) return;
      lastResendTs.current = now;
      resendCount.current += 1;
      conn.toggleMonitor();
    }, 250);
    return () => clearInterval(timer);
  }, [connected, connType]);

  const activeConn = () => (connType === 'ble' ? bleRef.current : serialRef.current);

  const handleConnect = async () => {
    if (connecting) return;
    if (connected) {
      await activeConn()?.disconnect();
      return;
    }

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
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-digital text-icom-text truncate leading-tight">
              {connected
                ? `${connType === 'ble' ? '蓝牙' : 'USB'} · ${deviceName || 'ATS-Mini'}`
                : autoConnecting
                  ? `正在自动连接 ${savedDevice?.name || '上次设备'}…`
                  : savedDevice
                    ? `未连接 · 上次 ${savedDevice.name || 'ATS-Mini'}`
                    : 'ATS MINI 未连接'}
            </div>
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
            stations={stations}
            onReadStations={handleReadStations}
            onSaveStation={handleSaveStation}
            onDeleteStation={handleDeleteStation}
          />
        </div>
      </div>
    </div>
  );
}
