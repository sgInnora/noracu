# noracu

**一个本地 MCP server：让 Claude、Cursor 或任意 MCP client 按 `element_index` 操作 macOS 应用和 Playwright 浏览器——并且（实验性地）经 Apple 的 iPhone Mirroring 操作真实 iPhone（在 Mac 上 OCR、按归一化坐标点击）。无 API key；server 本身无遥测。**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

For English, see [README.md](README.md).

一个 stdio MCP server。agent 对界面做一次快照、拿到带索引的元素列表，然后按 `element_index` 点击或输入，而不是用原始像素坐标——Mac 层和 Browser 层是同一套 observe/act 协议。

![browser element_index demo](https://raw.githubusercontent.com/sgInnora/noracu/v0.1.0/docs/demo-browser.gif)

*`browser_snapshot` 返回带索引的 ARIA 树；`browser_click` 按 `element_index` 动作。Mac 层跑同一个循环（`mac_ax_state` → `mac_click`）。高亮框是 `demo/record-browser.mjs` 录制时的叠加层，不是产品功能。iPhone 层不在此 demo 中。*

## 它做什么

一个 MCP server，三个控制面：

| 层 | 工具 | 底层 | 状态 |
|---|---|---|---|
| **Mac** | 9 个（`mac_*`） | cliclick、screencapture、JXA System Events | stable |
| **Browser** | 12 个（`browser_*`） | Playwright（持久化 profile） | stable |
| **iPhone** | 14 个（`phone_*`） | 经随包附带的 imctl 驱动 iPhone Mirroring（Python + pyobjc） | experimental |

iPhone 层是实验性的，驱动 imctl 随包附带（在 `imctl/`）。它需要 Apple 的 iPhone Mirroring，且 iPhone **锁定并靠近 Mac**，以及一个带 pyobjc 的 python3；它用 OCR 观察、按归一化坐标动作，而不是 `element_index`。没有 pyobjc 时，`phone_*` 工具返回一行带安装命令的 `imctl unavailable` 错误，Mac 层和 Browser 层不受影响。observe/act 词汇表沿用 ChatGPT computer-use 推广的 action/observation 拆分思路，在开放的本地工具上重新实现。

## 为什么用 noracu

noracu 是本地的"手"，不是"脑"。决策由你的 MCP client（Claude Desktop、Claude Code、Cursor）做；本 server 只在这台机器上观察与动作。

- **server 完全在本机运行。** 无云服务、无 API key、无遥测、无 postinstall 脚本。唯一运行期依赖是 Playwright。noracu 自身不发任何网络请求；唯一的自动网络行为是首次 `browser_launch` 时一次性下载 Chromium（`NORACU_DISABLE_AUTO_INSTALL=1` 可关闭）。你让浏览器打开的页面当然会被抓取，你的 MCP client 也仍会把工具结果（截图、OCR 文本）发给它所用的模型。
- **按语义动作，而非像素。** 观察返回 accessibility 树（Mac）或 ARIA 树（browser）的带索引列表——是文本，不是截图。动作引用 `element_index`；索引 30 秒后过期，点击前会重新校验目标（browser 校验 tag/name/href/位置，Mac 校验 frontmost app）。索引失效时返回 `element_no_longer_valid`，而不是点错位置。树不够用时才用截图。
- **一个循环，三个面。** Mac 原生应用和持久化 profile 的浏览器共用 `element_index` 协议（观察一棵树、按索引动作）。实验性的 iPhone 层在 Apple 的 iPhone Mirroring 上跑同一个 observe → act 循环，用的是 OCR 文本和归一化坐标——因为手机不向 Mac 暴露 accessibility 树。
- **用你真实的会话。** 你已登录的浏览器 profile、你的 Mac 应用——不是托管的 VM。与云端 computer-use 相比：两者没有谁普遍更可靠，只是失败方式不同。noracu 把屏幕留在你本机。
- **真正能关掉的开关。** `NORACU_READ_ONLY=1`（只观察，默认拒绝）、`NORACU_DISABLE_EVAL=1`、以及默认封禁 `file://`。见 [安全](#安全)。
- **可验证。** 39 项端到端检查（`npm test`）、CI 跑在 macos-latest、MIT 许可，整个 server 就一个文件：`src/server.mjs`。

**不适合的场景：** 你需要多个浏览器标签页或会话（当前仅单会话）、你不在 macOS 上（Mac 与 iPhone 层仅限 macOS；Browser 层跨平台）、或你现在就需要一个成品级的 iPhone 层（它已随包附带，但仍是实验性——而且 Apple 在欧盟不提供 iPhone Mirroring）。如果你只需要浏览器自动化，playwright-mcp 有 noracu v0.1 还没有的 tab 管理和 selector API；noracu 的价值在于：同一个 agent 还得离开浏览器去操作 Mac 应用。

## 快速开始

第一个该成功的调用是 `mac_ax_state`（或一次 browser 快照）——不是点击，也不是 `phone_*`。上手第一天最常见的失败是：把 macOS 权限授给了 `node` 而不是宿主应用；权限要在**完全退出并重开**宿主后才生效。

**1. 安装**（Node ≥ 20；无 postinstall 脚本）：

```bash
npm install noracu          # server 位于 node_modules/noracu/src/server.mjs
brew install cliclick       # Mac 输入所需（mac_click/type/key/paste）
```

或从源码：`git clone https://github.com/sgInnora/noracu.git && cd noracu && npm install && npm test`（加 `NORACU_CI=1` 可跳过依赖硬件的检查）。

**2. 接入你的 MCP client——用 `src/server.mjs` 的绝对路径。** 从 Finder/Dock 启动的 GUI 应用不继承你的 shell `PATH`，所以 `node` 二进制也要给绝对路径（`which node`）——裸 `node`、`npx` 或 `noracu` 都需要 Node 在 GUI `PATH` 上，否则会 `ENOENT` 失败。

Claude Desktop（`~/Library/Application Support/Claude/claude_desktop_config.json`）/ Cursor（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "noracu": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/绝对路径/TO/noracu/src/server.mjs"]
    }
  }
}
```

Claude Code：`claude mcp add noracu -- /绝对路径/TO/node /绝对路径/noracu/src/server.mjs`

用 `which node` 找到你的 node 路径（Apple Silicon：`/opt/homebrew/bin/node`；Intel：`/usr/local/bin/node`；nvm：对应版本路径）。便捷写法，仅当 Node 已在 GUI `PATH` 上时：`"command": "npx", "args": ["-y", "noracu"]`。

然后**完全退出宿主应用（含菜单栏图标）并重开**。工具列表能加载出来，说明 transport 通了——此时还不需要任何权限。

**3. 把 macOS 权限授给宿主应用，而不是 `node`。** 系统设置 → 隐私与安全性 → **辅助功能（Accessibility）** 和 **屏幕录制（Screen Recording）**（macOS 15 为"屏幕与系统音频录制"）→ 勾选宿主（Claude Desktop / Cursor / 你的终端）。noracu 不会出现在这里。授权后退出并重开宿主。

**4. 验证。** 让 Finder 在最前，调用 `mac_ax_state`（无参数）——它返回带索引的 accessibility 树；索引有效 30 秒。浏览器冒烟测试（不需要 Accessibility）：`browser_launch`（首次运行会下载 Chromium，除非 `NORACU_DISABLE_AUTO_INSTALL=1`）→ `browser_navigate` → `browser_snapshot` → 按索引 `browser_click`。

### 排障

| 现象 | 原因 / 解决 |
|---|---|
| `mac_*` 报错 **-1719** | Accessibility 没授给**宿主**应用——授权后退出并重开宿主 |
| 截图全黑 | Screen Recording 没授给宿主——授权后退出并重开 |
| `ENOENT` 提到 cliclick | `brew install cliclick`（或设 `NORACU_CLICLICK`） |
| GUI 宿主报 `spawn node` / `npx` `ENOENT` | 配置里改用绝对 `node` 路径——nvm/volta/homebrew 的 shim 不在 GUI `PATH` 上 |
| 首次 `browser_launch` 卡住 | 一次性 Chromium 下载；或自动安装被关闭（`NORACU_DISABLE_AUTO_INSTALL=1`）→ 执行 `npx playwright install chromium` |
| `phone_*` 报 `imctl unavailable: no python3 with pyobjc found` | 给某个 python3 装 pyobjc（`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`，通常选 Homebrew 的 python3）或设 `NORACU_PYTHON`——见[iPhone 层](#iphone-层实验性) |
| `phone_*` 被拒并报 `mirror_not_live: …`（"Connection Paused"、"iPhone in Use"） | 镜像已暂停或 iPhone 被解锁——锁上 iPhone、放在 Mac 旁，然后调用 `phone_launch`（会点击 Resume） |
| `phone_launch` 报 `mirror_setup_required` | iPhone Mirroring 正显示设置或欢迎页（例如升级 macOS 后首次启动）——请在 iPhone Mirroring 窗口里自己完成；noracu 从不替你点击这类页面 |
| `imctl_timeout: phone … did not finish within …s` | Mac 负载过高或系统卡住——操作可能已部分执行，重试前先看 `phone_status` / `phone_screenshot`（`phone_open` 超时后 noracu 会回到主屏幕）；在此期间 server 仍会响应其他调用 |
| `input_busy: …` | 前一个手机或 Mac 操作占用输入队列超过 60 秒；本次调用什么都没做——重试即可 |
| 已安装的 App，`phone_open` 却报 app not found | 它只点 Spotlight「Top Hit」卡片里的标签——名字要和手机图标下显示的一致（例如 `拼多多`，而不是 `Pinduoduo`）。已安装却报 "Spotlight showed no Top Hit"，通常说明 iPhone 系统语言不是英文：`phone_open` 读的是 Spotlight 的 "Top Hit" 标签——把 `NORACU_TOPHIT_LABELS` 设成手机上显示的标签。报 `open_not_confirmed: … never showed up on the phone` 则是粘贴的名字没有到达手机（粘贴到 iPhone 可能要好几秒）——重试即可。`phone_open` 之后剪贴板里是 App 名字 |
| 输入的文本被重新空格化（如 "no ra cu"） | 有 CJK 输入法在激活——用 `mac_paste` 代替 `mac_type` |
| `element_no_longer_valid` | 快照超过 30 秒或界面变了——重跑 `mac_ax_state` / `browser_snapshot` 并用新索引 |

启动时拒绝 Node 18——请用 Node ≥ 20。Claude Desktop 可能为每个使用面各起一个 noracu 进程；它们共享浏览器 profile，所以同一时间只从一个面启动浏览器。

完整实操示例见 [docs/usage.md](docs/usage.md)（英文）。

## iPhone 层（实验性）

noracu 可以经 Apple 的 **iPhone Mirroring** 操作真实 iPhone。agent 在 Mac 上用 OCR 观察（`phone_screenshot`、`phone_ocr`、`phone_find`），按 0–1 归一化坐标动作（`phone_tap`、`phone_swipe`、`phone_scroll`），用粘贴输入文字（`phone_type`），按名字打开 App（`phone_open`）。这不是 `element_index`：手机不向 Mac 暴露 accessibility 树，所以点击落在 OCR 识别出文字的位置。驱动（imctl，Python，MIT，约 1,000 行）随包附带在 `imctl/`。

**Apple 的要求**（[support.apple.com/120421](https://support.apple.com/120421)）：搭载 Apple 芯片或 T2 芯片、运行 macOS 15 或更高版本的 Mac；运行 iOS 18 或更高版本并设置了密码的 iPhone；两台设备登录同一个开启双重认证的 Apple 账户；蓝牙和 Wi-Fi 打开；Mac 没有共享互联网连接、没有使用 AirPlay 或随航（Sidecar）。**iPhone 必须锁定并靠近 Mac**——解锁 iPhone 或退出 iPhone Mirroring 都会结束会话。iPhone Mirroring 目前在欧盟不可用。一次只能一台 Mac 和一台 iPhone；摄像头和麦克风不会被镜像。

**无人值守：** 在 iPhone Mirroring → 设置里选「自动认证（Authenticate automatically）」，会话开始时就不再要求输入密码。代价：任何能使用你这台已解锁 Mac 的人都能打开你的手机。

**Python：** 驱动需要一个能导入 pyobjc（Quartz、Vision、AppKit）的 python3。设置 `NORACU_PYTHON`，或由 noracu 在首次调用 `phone_*` 时依次探测一次 `/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`python3`、`/usr/bin/python3`。Apple 自带的 `/usr/bin/python3` 通常没有 pyobjc；常见可用配置是 Homebrew 的 python3 加 `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`。

**镜像状态：** `phone_status` 返回 `live`（手机画面正在推流）、`overlay`（iPhone Mirroring 显示的替代文字，如 "Connection Paused"、"iPhone in Use"）、`paused`（该覆盖层带 Resume 按钮）和 `setup`（需要用户自己完成的设置或欢迎页——noracu 从不点击）。判定依据是窗口结构和形状（镜像窗口是竖长或横长的手机形状，设置页接近正方形），不是文字。镜像不在线时，`phone_tap`、`phone_longpress`、`phone_swipe`、`phone_scroll`、`phone_type`、`phone_key`、`phone_open` 会以 `mirror_not_live` 拒绝，而不是点到覆盖层上；`phone_ocr` / `phone_find` 的输出首行会给出警告。镜像闲置一段时间后会暂停；`phone_launch` 会把它置前并点击 Resume。

**隐私：** 手机上显示的一切——通知、短信、邮件、一次性验证码——都会变成工具输出，由你的 MCP client 发给它所用的模型。开始前打开专注模式、打开一个无关紧要的 App，并先用 `NORACU_READ_ONLY=1`（`phone_status`、`phone_screenshot`、`phone_ocr`、`phone_find` 仍可用；所有手机输入都会被拒绝）。iPhone Mirroring 设置好后，iPhone 的通知也会出现在 Mac 上。

**首次成功路径：** `phone_status` → 若 `live` 不是 `true` 先 `phone_launch` → `phone_screenshot` → `phone_ocr` → `phone_find` + `phone_tap`。

**已知限制：** 点击落在 OCR 识别到文字的位置，重复或识别错的标签可能点错（若 Spotlight 的「Top Hit」里是同名的联系人或网站，`phone_open` 分辨不出它不是 App）；`phone_scroll` 用触控板式的滚动事件移动列表（竖向的 `phone_swipe` 拖拽不会滚动列表——它用于主屏翻页这类手势）；在一套实测环境（iPhone 17 Pro Max 运行 iOS 27.0.1，Mac 运行 macOS 26.6.2）上，iPhone Mirroring 在所有 View 尺寸下都把手机画面画得比窗口大约 17%，右列和最底行被裁掉、无法点到；在显示器之间移动窗口、切换主屏、重开 App 都无效，主要怀疑是 iOS 27 与 macOS 26 版本错位——边缘附近点不中时先看 `phone_screenshot`；`phone_open` 把 App 名输入 Spotlight，只有当 Spotlight 的「Top Hit」卡片显示的正是这个名字时才点击（同名的网页建议、网站和设置行一律不点），否则回到主屏——它读的是 Spotlight 的英文 "Top Hit" 标签，iPhone 设为其他语言时找不到任何 App，除非用 `NORACU_TOPHIT_LABELS` 指定那个标签；`phone_home` / `phone_app_switcher` 走 iPhone Mirroring 菜单（英文 macOS），镜像连接时无需 python。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `NORACU_READ_ONLY` | 未设 | `=1` 只观察模式：默认拒绝的白名单仅 12 个观察 + 浏览器生命周期工具；所有 click/type/paste/key/eval 类工具被拒 |
| `NORACU_DISABLE_EVAL` | 未设 | `=1` 让 `browser_evaluate`（任意 JS）被调用时报错（仍在列表中） |
| `NORACU_ALLOW_FILE_URL` | 未设 | `=1` 允许 `browser_navigate` 打开 `file://` URL（默认封禁） |
| `NORACU_DISABLE_AUTO_INSTALL` | 未设 | `=1` 跳过首次 `browser_launch` 的 Chromium 自动安装 |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick 二进制路径 |
| `NORACU_PYTHON` | 自动探测 | 运行随包 iPhone 驱动的 python3；须能导入 pyobjc（Quartz、Vision、AppKit）。未设置时依次尝试 `/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`python3`、`/usr/bin/python3` |
| `NORACU_IMCTL_DIR` | 包内 `imctl/` | 覆盖驱动位置（仅开发用） |
| `NORACU_PHONE_TIMEOUT_MS` | 30000（`phone_open` / `phone_type` 为 45000） | iPhone 层每一步的时限，1000–600000 毫秒；到时该步被终止并返回 `imctl_timeout` |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | 识别 iPhone 画面的 OCR 语言及优先顺序（逗号分隔的 Vision 语言代码，如 `zh-Hant,en-US` 或 `en-US`；Vision 不支持的代码会被跳过并给出警告） |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | `phone_open` 要找的 Spotlight「Top Hit」分区标签，逗号分隔——iPhone 不是英文时，设成手机上实际显示的那个标签 |

## 安全

noracu 以你 MCP client 的权限运行。它会在本机点击、输入、粘贴、驱动真实浏览器——没有沙箱，没有远程确认弹窗。请在 server 条目上设好下面这些，然后完全退出宿主并重开：

```json
"env": { "NORACU_READ_ONLY": "1", "NORACU_DISABLE_EVAL": "1" }
```

- **`NORACU_READ_ONLY=1`** 是安全的首次运行模式。它拒绝不在 12 项白名单内的一切工具（观察类 + `browser_launch`/`browser_navigate`/`browser_close`）；所有 click/type/paste/eval 被拒。`browser_navigate` 在白名单内，仍会加载 URL。
- **`NORACU_DISABLE_EVAL=1`** 让 `browser_evaluate` 被调用时报错（仍列在 `tools/list` 中）。snapshot、click、type 保留。
- **`file://` 被拒**，除非 `NORACU_ALLOW_FILE_URL=1`，这样浏览器 agent 无法通过导航到 `~/Documents` 来读本地文件。（仅校验初始导航 URL；重定向不校验——见 SECURITY.md。）
- **焦点守卫：** 给 `mac_type` / `mac_paste` / `mac_key` 传 `app`，当该应用不在最前时输入被拒。不传 `app` 则守卫关闭。
- **失效元素保护：** `element_index` 不是坐标。它 30 秒后过期（`element_no_longer_valid`）；browser 点击会重校验 tag/name/href/位置，Mac 点击在 frontmost app 自快照以来变化时拒绝执行。
- **iPhone 画面就是模型输入：** `phone_screenshot` / `phone_ocr` / `phone_find` 会返回手机上显示的一切——通知、短信、一次性验证码。请用专注模式和无关紧要的 App，并先用 `NORACU_READ_ONLY=1`（允许观察手机、拒绝手机输入）。镜像暂停时手机输入同样会被拒绝（`mirror_not_live`）。
- **防注入 JXA：** 字符串参数以 argv 数据传给 `osascript`，绝不拼进脚本；唯一的数值参数（AX 读取 depth）在使用前 clamp 到 1–10。有回归测试覆盖。

这些开关不会让被观察的内容变得可信。截图文字、accessibility 名称、页面内容都是喂给你模型的**不可信输入**——别让它们覆盖任务指令。完整威胁模型与逐条状态见 [SECURITY.md](SECURITY.md)（英文）。

## 工具与文档

- 完整工具参考：[docs/tools.md](docs/tools.md)（由运行中的 server 自动生成）
- 使用实操：[docs/usage.md](docs/usage.md)
- 架构：[docs/architecture.md](docs/architecture.md)

## 路线图

- Browser：tab 管理（list / select / close）
- 动作词汇（browser）：`hover`、`set_value`、`wait_for`
- 快照 diffing 以降低 token 消耗——待测量
- iPhone：在 OCR 区域上提供 `element_index`，点击前重新校验文字

## 维护

个人维护，无 SLA。Mac 层需 macOS 15+；iPhone 层另需 Apple 芯片或 T2 的 Mac、iOS 18+ 和 iPhone Mirroring（欧盟不可用）；Browser 层随 Playwright 跨平台。

## 许可

MIT——见 [LICENSE](LICENSE)。
