# ATS Mini CN APK

ATS Mini 收音机的安卓遥控 App（中文版），基于 React + Capacitor 构建，通过 **蓝牙 BLE** 或 **USB 串口** 与收音机通信，在手机上 1:1 复刻真机屏幕并实现全部操作。

- **版本**：`1.0`（versionCode 33）
- **包名**：`com.ea5iyr.atsmini`
- **界面语言**：简体中文
- **最低系统**：Android 7.0（API 24）

---

## 功能

### 连接
- **双通道**：蓝牙 BLE / USB 串口，可随时切换
- **记住上次设备**：连接成功过的蓝牙设备会保存到本地，下次打开 App 直接连它，不再弹系统选择器
- **启动自动连接**：冷启动时自动重连上次设备（最多重试 2 次），失败静默降级，点「连接」可手动选设备
- **断连自愈**：连接中断后自动重试并恢复订阅

### 操控
- **屏幕镜像**：像素级复刻真机 LCD（状态栏、频率、波段、面板、RDS 等）
- **编码器三键**：顺时针 / 逆时针 / 点击进入，另设独立的短按、长按语义键
- **面板自动跟随**：手机端操作后，根据收音机回传的状态字段自动切换对应面板，避免菜单失步
- **全部功能键**：波段切换、模式（AM/FM/SSB）、带宽、步进、AGC/衰减、音量（含静音指示）、存储 / 读取 / 删除电台
- **横竖屏自适应**：竖屏上下布局、横屏左右分栏

### 界面
- 全中文文案，专业术语（AM / FM / SSB / AGC / BW / RDS 等）保留英文
- 复古无线电风格配色，数字字体显示频率

---

## 技术栈

| 层次 | 选型 |
|---|---|
| 前端 | React 19 + Vite 7 + Tailwind CSS 3 |
| 容器 | Capacitor 7（Android） |
| 蓝牙 | `@capacitor-community/bluetooth-le`（NUS 服务，Nordic UART） |
| 串口 | `@adeunis/capacitor-serial` |
| 原生 | Android Gradle 8 / JDK 21 |

`android/` 下保留了三个 Capacitor 插件的**本地副本**（`capacitor-android`、`adeunis-capacitor-serial`、`capacitor-community-bluetooth-le`），由 `android/capacitor.settings.gradle` 指向。**不要用 `npx cap update/sync` 覆盖该文件** —— 上游 npm 版本的串口插件已升到 1.0.7，与 Capacitor 7 不兼容，会导致启动白屏。

---

## 目录结构

```
├── src/
│   ├── components/
│   │   ├── ATSController.jsx   # 主控制器：连接、顶部状态、整体布局
│   │   └── RemoteScreen.jsx    # 屏幕镜像 + 按键 + 面板同步
│   ├── lib/
│   │   ├── BleConnection.js    # BLE 连接层（含记住设备 / 自动连接）
│   │   ├── SerialConnection.js # USB 串口连接层
│   │   ├── radioModel.js       # 固件 currentCmd 状态机 1:1 复刻
│   │   ├── screenRenderer.js   # 屏幕绘制（波段表、面板、静音等）
│   │   └── stationTuner.js     # 存储电台读写
│   ├── App.jsx
│   └── main.jsx
├── android/                    # Capacitor 安卓工程
├── public/                     # 静态资源与图标
├── capacitor.config.json
└── package.json
```

---

## 构建

### 环境
- Node.js 18+
- JDK 21
- Android SDK（Platform 35、Build-Tools 35）

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 构建网页资源
npm run build

# 3. 同步到安卓工程（只拷贝资源，不要用 cap sync / update）
npx cap copy android

# 4. 打包 APK
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` 需自行创建，指向本机 SDK：

```properties
sdk.dir=/path/to/Android/sdk
```

### 发布签名

仓库**不含任何签名文件**。正式发布需自行生成 keystore，并在 `android/app/build.gradle` 中配置 `signingConfigs`，或使用 `android/keystore.properties`（已在 `.gitignore` 中排除）。

---

## 通信协议

App 通过 Nordic UART（NUS）服务与固件通信：

| 用途 | UUID |
|---|---|
| 服务 | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| 写入（RX） | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| 通知（TX） | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

- **单字符命令**：`e` 点击、`E` 短按、`O` / `o` 开屏 / 关屏（与固件 `Button.cpp` 的按压时长判定对应）
- **蓝牙待机**：`Z` = 固件的「设置 → 休眠方式 → BLE 待机」+ 立即熄屏，一步做完。固件收到后先把 `sleepModeIdx` 存成 `SLEEP_BLE_KEEPALIVE`（以后真机长按也是这个效果），再走 `standbyEnter()`：用户静音（原本没静音时）→ 功放 EN 拉低 → 停 Wi-Fi → SI4732 `powerDown()` → CPU 降到 80MHz → 广播间隔放慢到 500ms。结果就是屏幕黑、喇叭不响、收音芯片断电、只剩 BLE 在线。
- **唤醒**：`y` = 唤醒 + 把休眠方式切回 `CPU 睡眠`（`SLEEP_LIGHT`）。固件先 `sleepOn(false)`（按**当前**档位正确恢复 CPU 频率、功放、SI4732、音量与背光），再把 `sleepModeIdx` 存成 `SLEEP_LIGHT` 并持久化。之所以唤醒时要改档：`Z` 会把档位持久化成 BLE 待机，若不改回来，之后真机长按编码器会再次断电静音。`CPU 睡眠` = 只熄屏、收音机继续放、BLE 在线，正是真机长按的常规行为。旧固件不认 `y`（`default: UnknownCommand`），App 800ms 内没等到 `sleep=0` 就降级补发 `o`。
  - 为什么不能只发 `O`：`O` 走的是固件里**当前配置的休眠方式**，出厂默认 `SLEEP_LOCKED`，效果只是黑屏，收音机照响 —— 这就是"点了待机没反应"的根因。
  - 旧固件不认 `Z`：App 1.4 秒没等到 `sleep=1` 就退回 `O`（行为与真机一致），并在界面上提示。想一步到位需要刷配套固件；不想刷也可以在收音机「设置 → 休眠方式」里手动选一次「BLE 待机」，之后按钮就正常了。
  - 待机中连接层会丢弃除 `o`/`O`/`Z` 以外的所有命令：固件在休眠时收到任何其它字节都会 `sleepOn(false)` 立刻唤醒，看门狗或探针漏一包，待机就停不住。
- **状态流**：固件每 500ms 推送一行状态，App 解析后渲染屏幕

### 状态流字段（29 项）

前 15 项是所有固件版本共有的原始格式，第 16 项起是汉化固件追加的界面状态：

| # | 含义 | # | 含义 |
|---|---|---|---|
| 0 | 固件版本 | 15 | `currentCmd` 当前界面 |
| 1 | 频率 | 16 | 背光值 |
| 2 | BFO | 17 | 息屏中 |
| 3 | 校准值 | 18 | 静音中 |
| 4 | 波段名 | 19 | 界面布局（0 默认 / 1 S-Meter） |
| 5 | 模式 | 20 | 主菜单光标 |
| 6 | 步进描述 | 21 | 设置菜单光标 |
| 7 | 带宽描述 | 22 | 定时待机剩余分钟 |
| 8 | AGC 索引 | 23 | 关机定时剩余分钟 |
| 9 | 音量 | 24 | 休眠定时（秒） |
| 10 | RSSI | 25 | 编码器档位（1 = 30定位） |
| 11 | SNR | 26 | FM 立体声导频 |
| 12 | 调谐电容 | 27 | 当前面板高亮项 |
| 13 | ADC 电压 | 28 | VFO A/B |
| 14 | 序号 | | |

App 在 `statusParser.js` 里统一解析：字段不足 26 项（旧固件）时 `ui` 为 `null`，退回本地状态机 + 探针推断；足 26 项时直接按固件回报的 `currentCmd` 渲染，不再靠「哪个字段在变化」去猜面板。

第 27 项「当前面板高亮项」是给所有列表面板共用的一个字段——固件内部 `uiLayoutIdx`、`sleepModeIdx`、`fmStereoIdx`、`usbModeIdx` 等各自独立，但任一时刻屏幕上只有一个面板，所以只推当前面板的那个索引就够了，不必为每张面板单独加字段。

### 两种主界面布局

固件 `Draw.cpp` 的 `drawScreen()` 按 `uiLayoutIdx` 分派，App 的 `renderScreen()` 与之对应：

| `uiLayoutIdx` | 固件函数 | 特征 |
|---|---|---|
| 0 | `drawLayoutDefault()` | 侧边栏下移 18px；底部频率游标尺；左上角小 S 表；右下角 RSSI/SNR |
| 1 | `drawLayoutSmeter()` | 侧边栏贴顶（y=0）；64.00–108.00 小刻度尺；底部 S/N 双条表；频率右侧双环立体声指示 |

S-Meter 布局的 S 表不是线性的：`getInterpolatedStrength()` 用一张 AM/FM 各自的折线表把 RSSI 插值成 49 格里的格数（FM 时 RSSI 39 → 36 格），与默认布局的 `getStrength()` 是两套算法，不能互相替代。

### 心跳命令

`t` 是**翻转**语义（发一次翻一次），App 用它保活容易把状态流关掉。固件另提供幂等的 `g`（开启状态流，永不关闭），只有支持扩展状态流的固件才会收到它。`t` 与 `g` 在息屏休眠时都不会唤醒设备。

---

## 配套固件

本项目配套一份**汉化固件**（ATS Mini 固件，基于 esp32-si4732/ats-mini 修改）：

- 屏幕 UI 全中文（挂载 u8g2 文泉驿 16px GB2312 点阵字体），专业术语保留英文
- Web 配置页中文化
- 新增「蓝牙后台」睡眠模式（`SLEEP_BLE`）：关屏与 WiFi，仅保留 BLE 广播，唤醒后自动恢复
- BLE 广播看门狗：断连后自动重启广播，解决 App 退出重开后搜不到设备的问题

固件源码与编译不在本仓库内。

---

## 版本记录

### 1.0（versionCode 33）
- 记住上次连接过的蓝牙设备，启动时自动直连
- 连接失败降级：优先直连 → 失败再弹系统选择器
- 顶部状态栏显示「正在自动连接 / 未连接 · 上次设备名」

### 1.0（versionCode 13 ~ 32）
- 面板同步探针机制，修复手机与收音机菜单失步
- 按压拆分为点击 / 短按 / 长按三个语义键
- 横竖屏自适应布局
- 真机屏幕 1:1 复刻、波段表校正、音量面板静音指示

---

## 许可证

上游 [ATS-Mini-Companion](https://github.com/rodillo69/ATS-Mini-Companion) 未附带明确的许可证文件，本仓库作为其汉化定制版本的源码留档公开，**未另行声明许可证**。如需商用或再分发，请先确认上游授权。

---

## 致谢

- 上游项目：[rodillo69/ATS-Mini-Companion](https://github.com/rodillo69/ATS-Mini-Companion)
- 固件：[esp32-si4732/ats-mini](https://github.com/esp32-si4732/ats-mini)
- 点阵字体：[u8g2](https://github.com/olikraus/u8g2)（文泉驿 GB2312）
