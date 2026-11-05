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
- **状态流**：固件每 500ms 推送一行状态，App 解析后渲染屏幕
- 状态流**不含** `currentCmd` 字段，因此面板归属只能由「哪个字段发生变化」反推（`RemoteScreen.jsx` 中的 WATCH 表 + 探针机制）

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
