/**
 * BleConnection - BLE (Nordic UART Service) connection to ATS Mini
 *
 * 对接 ATS Mini 固件 Settings -> Bluetooth -> Ad hoc 模式：
 *   Service UUID: 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   RX (App -> Radio, Write):        6E400002-B5A3-F393-E0A9-E50E24DCCA9E
 *   TX (Radio -> App, Notify):       6E400003-B5A3-F393-E0A9-E50E24DCCA9E
 *
 * 命令协议与 USB 串口完全一致（单字符 ASCII 命令 + 逗号分隔监视器数据流），
 * 因此接口与 SerialConnection 保持一致，可互换使用。
 *
 * 依赖: @capacitor-community/bluetooth-le (Capacitor Android)
 */

import { BleClient } from '@capacitor-community/bluetooth-le';
import { parseStatusLine } from './statusParser';

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify

/** 上次成功连接过的设备（Android 上是 MAC，iOS 是 UUID），存本地供下次直连 */
const LAST_DEVICE_KEY = 'atsmini.lastBleDevice';

export function getSavedBleDevice() {
  try {
    const raw = localStorage.getItem(LAST_DEVICE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.deviceId ? obj : null;
  } catch {
    return null;
  }
}

export function forgetSavedBleDevice() {
  try {
    localStorage.removeItem(LAST_DEVICE_KEY);
  } catch { /* ignore */ }
}

function rememberDevice(deviceId, name) {
  try {
    localStorage.setItem(
      LAST_DEVICE_KEY,
      JSON.stringify({ deviceId, name: name || 'ATS-Mini', ts: Date.now() })
    );
  } catch { /* ignore */ }
}

/** 用户在系统选择器里取消选择，不算错误 */
function isUserCancelled(err) {
  const msg = String(err && (err.message || err));
  return /cancel|取消|rejected|dismiss/i.test(msg);
}

/**
 * 休眠期间允许发出的命令白名单。
 *
 * 固件 BleMode.cpp 的规则：休眠中只要收到『不是 t / g / CR / LF』的字节，
 * 就会 sleepOn(false) 立刻唤醒。所以看门狗、探针、跳台这些后台命令一旦漏出来，
 * 待机会被瞬间打断 —— 表现为「点了待机，收音机没反应/马上又亮」。
 * 这里在连接层做硬拦截，只放行待机与唤醒本身。
 */
const SLEEP_ALLOWED = new Set(['o', 'O', 'Z', 'y']);

/** 把命令字符串转成 DataView（插件的 write 只接受带 .buffer 的二进制数据） */
function stringToDataView(str) {
  const bytes = new TextEncoder().encode(str);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new DataView(buf);
}

function decodeView(value) {
  if (typeof value === 'string') return value;
  if (value instanceof DataView) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new DataView(value));
  }
  return '';
}

export class BleConnection {
  constructor() {
    this.deviceId = null;
    this.deviceName = '';
    this.connected = false;
    this.sleeping = false;
    this.logOn = false;
    // 状态流里带界面字段 = 汉化固件新版，支持幂等 'g' 心跳命令
    this.hasExtendedStatus = false;
    this.buffer = '';
    this.notifyListener = null;
    this.monitorCallback = null;
    this.uiCallback = null;
    this.errorCallback = null;
    this.connectionCallback = null;
    this.rawDataCallback = null;
    this.available = true;
  }

  static isSupported() {
    // Capacitor 平台必有原生插件；Web 平台走插件的 Web Bluetooth 实现
    return true;
  }

  onMonitorData(cb) { this.monitorCallback = cb; }
  /** 固件回报的界面状态（currentCmd / 光标 / 休眠等），旧固件不会触发 */
  onUiData(cb) { this.uiCallback = cb; }
  onRawData(cb) { this.rawDataCallback = cb; }
  onError(cb) { this.errorCallback = cb; }
  onConnectionChange(cb) { this.connectionCallback = cb; }

  _emitError(err) {
    console.error('[BLE] Error:', err);
    if (this.errorCallback) this.errorCallback(err instanceof Error ? err : new Error(String(err)));
  }

  /**
   * 建立连接（不弹系统选择器）。供「上次设备直连」和「选择器选完」两条路共用。
   */
  async _open(deviceId, name) {
    this.deviceId = deviceId;
    this.deviceName = name || 'ATS-Mini';

    // 连接（带断连回调）
    await BleClient.connect(this.deviceId, (id) => {
      console.log('[BLE] Device disconnected:', id);
      this.connected = false;
      this.buffer = '';
      if (this.connectionCallback) this.connectionCallback(false);
    });

    // 订阅固件 TX 通知（监视器数据流）
    this.notifyListener = (value) => {
      const text = decodeView(value);
      this.buffer += text;

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) this.processReceivedData(line.trim());
      }
    };
    await BleClient.startNotifications(this.deviceId, NUS_SERVICE, NUS_TX, this.notifyListener);

    this.connected = true;
    // 只有连成功才记住，避免把连不上的设备存下来
    rememberDevice(this.deviceId, this.deviceName);
    if (this.connectionCallback) this.connectionCallback(true);
  }

  /**
   * 连接设备。流程（顺序很重要）：
   * 1. initialize() —— 申请 Android 12+ 蓝牙扫描/连接运行时权限，必须先于扫描
   * 2. （可选）直连上次成功连接过的设备，不弹选择器
   * 3. requestDevice() —— 弹出系统 BLE 设备选择器
   * 4. connect() —— 建立连接
   * 5. startNotifications() —— 订阅固件监视器数据流
   *
   * @param {{preferSaved?: boolean, onlySaved?: boolean, silent?: boolean}} opts
   *   preferSaved: 先尝试直连上次设备，失败再弹选择器
   *   onlySaved:   只尝试直连上次设备，失败就返回 false（App 启动时用，不打扰用户）
   *   silent:      失败时不弹错误提示
   */
  async connect(opts = {}) {
    const { preferSaved = false, onlySaved = false, silent = false } = opts;
    const saved = preferSaved || onlySaved ? getSavedBleDevice() : null;

    try {
      this.connected = false;

      // 第 1 步：初始化插件并申请运行时权限（Android 12+ 必需）
      // androidNeverForLocation: 配合 Manifest 的 neverForLocation 标记，
      // 避免 Android 强制要求定位权限
      await BleClient.initialize({ androidNeverForLocation: true });

      // 第 2 步：直连上次设备（Android 记住 MAC，无需再扫）
      if (saved) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await this._open(saved.deviceId, saved.name);
            console.log('[BLE] 已自动连接上次设备:', saved.name);
            return true;
          } catch (e) {
            console.log(`[BLE] 直连上次设备失败(第 ${attempt} 次):`, e);
            try { await BleClient.disconnect(saved.deviceId); } catch { /* ignore */ }
            this.deviceId = null;
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
          }
        }
        if (onlySaved) {
          this.connected = false;
          return false;
        }
      } else if (onlySaved) {
        return false;
      }

      // 第 3 步：弹出系统蓝牙设备选择器，用户选择 "ATS-Mini"
      let device;
      try {
        device = await BleClient.requestDevice({
          acceptAllDevices: true,
          optionalServices: [NUS_SERVICE],
        });
      } catch (scanErr) {
        if (isUserCancelled(scanErr)) {
          console.log('[BLE] 用户取消了设备选择');
          return false;
        }
        // 某些固件不在广播里带 NUS 服务 UUID 时，扫描过滤可能失败，
        // 回退为不带服务过滤再试一次
        console.warn('[BLE] 按服务过滤扫描失败，尝试全量扫描:', scanErr);
        device = await BleClient.requestDevice({
          acceptAllDevices: true,
        });
      }

      // 第 4、5 步：连接 + 订阅通知
      await this._open(device.deviceId, device.name || 'ATS-Mini');
      return true;
    } catch (error) {
      this.connected = false;
      if (this.connectionCallback) this.connectionCallback(false);
      if (isUserCancelled(error)) {
        console.log('[BLE] 连接流程被取消');
        return false;
      }
      if (silent) return false;
      const msg = String(error && (error.message || error));
      let hint = msg;
      if (/permission|权限|SecurityException/i.test(msg)) {
        hint = '蓝牙权限被拒绝：请在系统设置里给本 App 开启"附近的设备"权限后重试。';
      } else if (/distance|GATT|133|timeout/i.test(msg)) {
        hint = '蓝牙连接失败（错误 ' + msg + '）：请靠近收音机（5 米内）、确认收音机端 BLE 模式已开启后重试。';
      }
      this._emitError(new Error(hint));
      return false;
    }
  }

  async disconnect() {
    try {
      if (this.deviceId && this.connected) {
        try {
          await BleClient.stopNotifications(this.deviceId, NUS_SERVICE, NUS_TX);
        } catch (e) { /* ignore */ }
        await BleClient.disconnect(this.deviceId);
      }
    } catch (error) {
      this._emitError(error);
    } finally {
      this.deviceId = null;
      this.deviceName = '';
      this.notifyListener = null;
      this.buffer = '';
      if (this.connected) {
        this.connected = false;
        if (this.connectionCallback) this.connectionCallback(false);
      }
    }
  }

  processReceivedData(data) {
    if (this.rawDataCallback) this.rawDataCallback(data);

    const parsed = parseStatusLine(data);
    if (!parsed) return;

    // 固件回报的休眠状态是权威值，用来纠正本地猜测
    if (parsed.ui) {
      this.hasExtendedStatus = true;
      this.sleeping = parsed.ui.sleep;
    }

    if (this.monitorCallback) this.monitorCallback(parsed.monitor);
    if (parsed.ui && this.uiCallback) this.uiCallback(parsed.ui);
  }

  async sendCommand(command) {
    if (!this.connected || !this.deviceId) {
      throw new Error('蓝牙未连接');
    }
    // 待机中只放行待机/唤醒命令，其余一律不发（固件收到任何字节都会醒）
    if (this.sleeping && !SLEEP_ALLOWED.has(String(command))) {
      console.log('[ATS Mini BLE] 待机中丢弃:', command);
      return;
    }
    try {
      console.log('[ATS Mini BLE TX]:', command);
      // 插件 write() 只接受 DataView，不接受字符串
      await BleClient.write(this.deviceId, NUS_SERVICE, NUS_RX, stringToDataView(command));
    } catch (error) {
      // 部分固件的 RX 特征只支持"无响应写入"，回退再试一次
      try {
        await BleClient.writeWithoutResponse(this.deviceId, NUS_SERVICE, NUS_RX, stringToDataView(command));
      } catch (error2) {
        this._emitError(error2);
      }
    }
  }

  // ==================== 控制命令（与 SerialConnection 一致） ====================

  rotateUp() { return this.sendCommand('R'); }
  rotateDown() { return this.sendCommand('r'); }
  nextBand() { return this.sendCommand('B'); }
  prevBand() { return this.sendCommand('b'); }
  nextMode() { return this.sendCommand('M'); }
  prevMode() { return this.sendCommand('m'); }
  volumeUp() { return this.sendCommand('V'); }
  volumeDown() { return this.sendCommand('v'); }
  backlightUp() { return this.sendCommand('L'); }
  backlightDown() { return this.sendCommand('l'); }
  agcUp() { return this.sendCommand('A'); }
  agcDown() { return this.sendCommand('a'); }
  calibrationUp() { return this.sendCommand('I'); }
  calibrationDown() { return this.sendCommand('i'); }
  nextBandwidth() { return this.sendCommand('W'); }
  prevBandwidth() { return this.sendCommand('w'); }
  nextStep() { return this.sendCommand('S'); }
  prevStep() { return this.sendCommand('s'); }
  encoderPress() { return this.sendCommand('e'); }
  // 'e' = 编码器点击（菜单），'E' = 编码器短按（音量/返回）
  encoderShortPress() { return this.sendCommand('E'); }
  // 休眠：'O' 只熄屏（默认 SLEEP_LOCKED 模式下按编码器唤不醒），'o' 才真正亮屏
  sleepOn() { this.sleeping = true; return this.sendCommand('O'); }
  sleepOff() { this.sleeping = false; return this.sendCommand('o'); }
  // 强制蓝牙待机（'Z'）：绕过设置里的休眠方式，屏幕/音频/收音全关，只留 BLE
  // 活着，App 才能再把它唤醒。'O' 走的是用户配置的那一档，设成 CPU 睡眠时
  // 蓝牙会一起断，之后就连不上了 —— 这是「蓝牙休眠不对」的根因。
  bleStandby() { this.sleeping = true; return this.sendCommand('Z'); }
  // 唤醒并把『休眠方式』切成 CPU 睡眠（'y'）：屏幕亮、收音机继续放、BLE 在线。
  // 之后真机长按编码器也只是熄屏，不会再进 BLE 待机断电。旧固件不认 'y'，
  // 调用方负责超时后降级到 sleepOff()（'o'）。
  wakeLight() { this.sleeping = false; return this.sendCommand('y'); }
  toggleSleep() {
    return this.sleeping ? this.sleepOff() : this.sleepOn();
  }
  // 监视器日志是『开关』语义：发一次 t 翻转一次，记下状态避免误关
  // 监视器日志：'t' 是翻转语义，'g' 是幂等开启。
  // 新固件（状态流带界面字段）认 'g'，看门狗反复重发也不会把状态流关掉；
  // 旧固件不认 'g'，只能继续用 't' 并靠本地 logOn 记账。
  toggleMonitor() {
    if (this.hasExtendedStatus) return this.sendCommand('g');
    this.logOn = !this.logOn;
    return this.sendCommand('t');
  }

  ensureMonitor() {
    if (this.hasExtendedStatus) return this.sendCommand('g');
    return this.logOn ? Promise.resolve() : this.toggleMonitor();
  }

  // 删除存储槽：固件 remoteSetMemory() 以频率 0 表示清空
  deleteStation(slot, band, mode) {
    const slotStr = String(slot).padStart(2, '0');
    return this.sendCommand(`#${slotStr},${band},0,${mode}\n`);
  }
  takeScreenshot() { return this.sendCommand('C'); }
  showMemorySlots() { return this.sendCommand('$'); }

  // 直接调谐到指定频率（Hz）。F/# 命令按固件协议必须以换行符结尾
  setFrequency(freqHz) { return this.sendCommand(`F${Math.round(freqHz)}\n`); }

  async setMemorySlot(slot, band, frequency, mode, name) {
    // 名称参数：省略 = 保留原名；空串 = 清除名称；固件限制 9 字符以内
    const slotStr = String(slot).padStart(2, '0');
    const namePart = name === undefined || name === null ? '' : `,${String(name).slice(0, 9)}`;
    await this.sendCommand(`#${slotStr},${band},${frequency},${mode}${namePart}\n`);
  }

  toggleThemeEditor() { return this.sendCommand('T'); }
  getCurrentTheme() { return this.sendCommand('@'); }

  // 主题写入：'^' + 44 组 xHHHH = 221 字节，超过单包 MTU，按块发送
  // （固件按长度成帧，分块到达不影响解析）
  async setTheme(themeCommand) {
    const cmd = String(themeCommand).startsWith('^') ? themeCommand : `^${themeCommand}`;
    await this.sendLongCommand(cmd);
  }

  /** 长命令分块发送（BLE 单包受限，块间留一点间隔避免撑爆发送队列） */
  async sendLongCommand(command, chunkSize = 100) {
    const str = String(command);
    if (str.length <= chunkSize) return this.sendCommand(str);
    for (let i = 0; i < str.length; i += chunkSize) {
      await this.sendCommand(str.slice(i, i + chunkSize));
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
