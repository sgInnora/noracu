# noracu

**一个本地 MCP server：让 Claude、Cursor 或任意 MCP client 按 `element_index` 操作 macOS 应用和 Playwright 浏览器——并且（实验性地）经 Apple 的 iPhone Mirroring 操作真实 iPhone（在 Mac 上 OCR、按归一化坐标点击）。无 API key；server 本身无遥测。**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

For English, see [README.md](README.md).

一个 stdio MCP server。agent 对界面做一次快照、拿到带索引的元素列表，然后按 `element_index` 点击或输入，而不是用原始像素坐标——Mac 层和 Browser 层是同一套 observe/act 协议。实验性的 iPhone 层在 OCR 文本和归一化坐标上跑同一个 observe → act 循环。

![noracu 0.3.0 演示](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-demo.gif)

*noracu 0.3.0 在人自己的 Chrome 里（`browser_launch` 带 `chrome: true`）：它在项目的 GitHub 页面上开一个自己的标签，从页面读出 star 数，再把它打进备忘录里新建的一条。Browser 层的 `element_index` 循环见 [v0.1.0 演示](https://raw.githubusercontent.com/sgInnora/noracu/v0.1.0/docs/demo-browser.gif)。*

## 它做什么

一个 MCP server，三个控制面：

| 层 | 工具 | 底层 | 状态 |
|---|---|---|---|
| **Mac** | 20 个（`mac_*`） | macOS 辅助功能 API（`src/mac-ax.js`，JXA）、cliclick、screencapture | stable |
| **Browser** | 13 个（`browser_*`） | Playwright（自己的持久化 profile，或带 `chrome: true` 用你自己的 Chrome，实验性） | stable |
| **iPhone** | 14 个（`phone_*`） | 经随包附带的 imctl 驱动 iPhone Mirroring（Python + pyobjc） | experimental |
| **iPhone**，XCUITest 后端 | 9 个（`ios_*`，取代 `phone_*` 列出） | 跑在手机上的 UI 测试 runner（`ios-runner/`）、Xcode 的 `devicectl` | experimental，需显式开启 |

iPhone 层是实验性的，默认关闭（`NORACU_LAYERS=mac,browser,iphone` 打开），驱动 imctl 随包附带（在 `imctl/`）。它需要 Apple 的 iPhone Mirroring，且 iPhone **锁定并靠近 Mac**，以及一个带 pyobjc 的 python3；它用 OCR 观察、按归一化坐标动作，而不是 `element_index`。没有 pyobjc 时，`phone_*` 工具返回一行带安装命令的 `imctl unavailable` 错误，Mac 层和 Browser 层不受影响。observe/act 词汇表沿用 ChatGPT computer-use 推广的 action/observation 拆分思路，在开放的本地工具上重新实现。

第二套 iPhone 后端需要显式开启：设置 `NORACU_PHONE_BACKEND=xcuitest` 后，`phone_*` 换成 9 个 `ios_*` 工具，它们读取手机自己的辅助功能元素、按 `element_index` 动作，靠的是一个用 Xcode 构建的小 UI 测试 runner——见 [XCUITest 后端](#xcuitest-后端实验性需显式开启)。

## 为什么用 noracu

noracu 是本地的"手"，不是"脑"。决策由你的 MCP client（Claude Desktop、Claude Code、Cursor）做；本 server 只在这台机器上观察与动作。

- **server 完全在本机运行。** 无云服务、无 API key、无遥测、无 postinstall 脚本。唯一运行期依赖是 Playwright。noracu 自身不发任何网络请求；唯一的自动网络行为是首次 `browser_launch` 时一次性下载 Chromium（`NORACU_DISABLE_AUTO_INSTALL=1` 可关闭）。设置 `NORACU_ALLOW_CDP=1` 后，它还会访问自己在 127.0.0.1 上打开的 DevTools 端口（连接其他本地回环端口需 `NORACU_ALLOW_CDP=any`）。你让浏览器打开的页面当然会被抓取，你的 MCP client 也仍会把工具结果（截图、OCR 文本）发给它所用的模型。
- **按语义动作，而非像素。** 观察返回 accessibility 树（Mac 直接经 macOS 辅助功能 API 读取——在我们的测试机上，500 个元素的窗口约 0.15 秒）或 ARIA 树（browser）的带索引列表——是文本，不是截图。动作引用 `element_index`；索引 30 秒后过期。Mac 上每个索引背后都有身份证据（窗口 ID、子节点路径、角色、标识符、名称），每次动作前先重新识别元素；browser 则重校验 tag/name/href/位置。元素已消失或已变化时返回 `element_no_longer_valid`，而不是点错位置。树不够用时才用截图。
- **如实报告结果。** Mac 动作优先用元素自己的辅助功能动作（按下、选中、设值、插入文本——不移动指针、不抢焦点，文字输入不受输入法影响）；只有命中检测确认该点确实落在元素上，才会发送物理点击。每个输入动作（Mac、浏览器和 iPhone）的结果都写明是否送达（观察到变化为 `delivered_verified`，另有 `delivered_unverified`、`not_delivered`，以及超时或中途失败时的 `unknown`）以及能否安全重试；Mac 动作还会列出它打开的 sheet、对话框或菜单。
- **和你共用这台 Mac。** Mac 与 iPhone 的输入让电脑前的人先来：最近 2 秒内键盘或鼠标被用过（不是 noracu 自己），输入工具就返回 `user_active`、什么都不发；物理点击、拖动、滚动和手机手势之后，指针回到原处，除非这期间有人动过它。只读工具和浏览器层不受影响。专给 agent 用的 Mac 上设 `NORACU_USER_IDLE_S=0` 关闭。
- **一个循环，三个面。** Mac 原生应用和持久化 profile 的浏览器共用 `element_index` 协议（观察一棵树、按索引动作）。实验性的 iPhone 层在 Apple 的 iPhone Mirroring 上跑同一个 observe → act 循环，用的是 OCR 文本和归一化坐标——因为手机不向 Mac 暴露 accessibility 树。
- **用你真实的会话。** 你已登录的浏览器 profile、你的 Mac 应用——不是托管的 VM。与云端 computer-use 相比：两者没有谁普遍更可靠，只是失败方式不同。noracu 把屏幕留在你本机。
- **真正能关掉的开关。** `NORACU_READ_ONLY=1`（只观察，默认拒绝）和 `NORACU_DISABLE_EVAL=1`；`browser_evaluate`（任意 JS）和 `file://` 默认关闭。见 [安全](#安全)。
- **可验证。** 端到端测试（`npm test`；不依赖硬件的部分在 macos-latest 上跑 CI）、MIT 许可；server 由 `src/server.mjs` 和 Mac 辅助功能引擎 `src/mac-ax.js` 组成。

![人优先](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-person-goes-first.gif)

*noracu 每秒往一条备忘录里打一个 `#n`。鼠标在动的时候，每次调用都返回 `user_active`，什么都不打（编号里断开的那几个）；鼠标停下 2 秒后，接着打。*

**不适合的场景：** 你需要同时开多个浏览器会话（只有一个会话；`browser_tabs` 可以列出、打开、切换、关闭其中的标签页）、你不在 macOS 上（Mac 与 iPhone 层仅限 macOS；Browser 层跨平台）、或你现在就需要一个成品级的 iPhone 层（它已随包附带，但仍是实验性——而且 Apple 在欧盟不提供 iPhone Mirroring）。如果你只需要浏览器自动化，playwright-mcp 有 noracu 还没有的 selector API。如果你要在 Windows 或 Linux 上操作桌面应用，agent-desktop（Vercel Labs）经各系统的辅助功能 API 覆盖 macOS、Windows 和 Linux；noracu 的桌面层只支持 macOS。noracu 的价值在于：一个 agent 通过同一个 server 操作 Mac 应用、浏览器和 iPhone。

## 快速开始

**一行安装（从终端启动的 Claude Code，`PATH` 里有 Node ≥ 20）：** `claude mcp add noracu -- npx -y noracu`——然后按第 3 步授权。Claude Desktop 和 Cursor 要用第 2 步的绝对路径。

第一个该成功的调用是 `mac_ax_state`（或一次 browser 快照）——不是点击，也不是 `phone_*`。上手第一天最常见的失败是：把 macOS 权限授给了 `node` 而不是宿主应用；权限要在**完全退出并重开**宿主后才生效。

**1. 安装**（Node ≥ 20；无 postinstall 脚本）：

```bash
npm install noracu          # server 位于 node_modules/noracu/src/server.mjs
brew install cliclick       # 物理 Mac 输入所需（mac_key、mac_drag 及物理路径的 mac_click/mac_type）
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

Claude Code：`claude mcp add noracu -- /绝对路径/TO/node /绝对路径/TO/noracu/src/server.mjs`

用 `which node` 找到你的 node 路径（Apple Silicon：`/opt/homebrew/bin/node`；Intel：`/usr/local/bin/node`；nvm：对应版本路径）。便捷写法，仅当 Node 已在 GUI `PATH` 上时：`"command": "npx", "args": ["-y", "noracu"]`。

然后**完全退出宿主应用（含菜单栏图标）并重开**。工具列表能加载出来，说明 transport 通了——此时还不需要任何权限。

**3. 把 macOS 权限授给宿主应用，而不是 `node`。** 系统设置 → 隐私与安全性 → **辅助功能（Accessibility）** 和 **屏幕录制（Screen Recording）**（macOS 15 为"屏幕与系统音频录制"）→ 勾选宿主（Claude Desktop / Cursor / 你的终端）。noracu 不会出现在这里。授权后退出并重开宿主。

**4. 验证。** 先调用 `mac_status`——它会报告宿主是否有辅助功能和屏幕录制权限、能否找到 cliclick。然后让 Finder 在最前，调用 `mac_ax_state`（无参数）——它返回带索引的 accessibility 树；索引有效 30 秒。浏览器冒烟测试（不需要 Accessibility）：`browser_launch`（首次运行会下载 Chromium，除非 `NORACU_DISABLE_AUTO_INSTALL=1`）→ `browser_navigate` → `browser_snapshot` → 按索引 `browser_click`。

### 排障

| 现象 | 原因 / 解决 |
|---|---|
| `mac_*` 报 `permission_denied: Accessibility permission is missing…`（0.2 之前为错误 **-1719**） | Accessibility 没授给**宿主**应用——授权后退出并重开宿主；`mac_status` 可查看状态 |
| 截图全黑 | Screen Recording 没授给宿主——授权后退出并重开 |
| `ENOENT` 提到 cliclick | `brew install cliclick`（或设 `NORACU_CLICLICK`） |
| GUI 宿主报 `spawn node` / `npx` `ENOENT` | 配置里改用绝对 `node` 路径——nvm/volta/homebrew 的 shim 不在 GUI `PATH` 上 |
| 首次 `browser_launch` 卡住 | 一次性 Chromium 下载；或自动安装被关闭（`NORACU_DISABLE_AUTO_INSTALL=1`）→ 执行 `npx playwright install chromium` |
| `phone_*` 报 `imctl unavailable: no python3 with pyobjc found` | 给某个 python3 装 pyobjc（`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa`，通常选 Homebrew 的 python3）或设 `NORACU_PYTHON`——见[iPhone 层](#iphone-层实验性) |
| `phone_*` 被拒并报 `mirror_not_live: …`（"Connection Paused"、"iPhone in Use"、"not running"）或 `mirror_state_unknown: …` | 镜像未运行、已暂停或状态无法读取——锁上 iPhone、放在 Mac 旁，检查 `phone_status`，再调用 `phone_launch`（会启动镜像并点击 Resume） |
| `phone_launch` 报 `mirror_setup_required` | iPhone Mirroring 正显示设置或欢迎页（例如升级 macOS 后首次启动）——请在 iPhone Mirroring 窗口里自己完成；noracu 从不替你点击这类页面 |
| `imctl_timeout: phone … did not finish within …s` | Mac 负载过高或系统卡住——操作可能已部分执行，重试前先看 `phone_status` / `phone_screenshot`（`phone_open` 超时后 noracu 会回到主屏幕）；在此期间 server 仍会响应其他调用 |
| `input_busy: …` | 前一个手机或 Mac 操作占用输入队列超过 60 秒（或 `NORACU_PHONE_TIMEOUT_MS` + 15 秒）；本次调用什么都没做——重试即可 |
| `user_active: …` | 最近 2 秒内有人用过这台 Mac 的键盘或鼠标——什么都没发；停一下再重试。没有别人用的 Mac 上，`NORACU_USER_IDLE_S=0` 关闭这项检查 |
| 已安装的 App，`phone_open` 却报 app not found | 它只点 Spotlight「Top Hit」卡片里的 App 标签；若 Spotlight 把搜索框放在顶部、没有「Top Hit」卡片，则只在搜索框把名字补全成「<名字> — Open」时点搜索框正下方的标签——名字要和手机图标下显示的一致（例如 `拼多多`，而不是 `Pinduoduo`）。已安装却报 "Spotlight showed no Top Hit"，通常说明 iPhone 系统语言不是英文：`phone_open` 读的是 Spotlight 的 "Top Hit" 标签——把 `NORACU_TOPHIT_LABELS` 设成手机上显示的标签（它只管「Top Hit」标签；「— Open」补全只认英文）。报 `open_not_confirmed: … never showed up on the phone` 是说 ⌘V 之后 Spotlight 里一直没出现这个名字：可能粘贴还没到（可能要好几秒），也可能手机把自己的旧剪贴板贴进了搜索框——重试即可，`phone_open` 会先清空搜索框。只有一两个字母的名字（如 `X`）OCR 常常读不出来，`phone_open` 会报 `open_not_confirmed` 且不点任何东西——这类 App 请从主屏图标打开（先 `phone_screenshot`，再 `phone_tap`）。`phone_open` 之后剪贴板里是 App 名字 |
| 输入的文本被重新空格化（如 "no ra cu"） | 文字是以按键方式送出的（`mac_type` 用了 `mechanism: "physical"`，或焦点元素不接受辅助功能写入），同时 CJK 输入法在激活——用 `mac_type` 的默认方式，或用 `mac_paste` |
| `element_no_longer_valid` | 快照超过 30 秒，或元素已消失、已变化、所在窗口已关闭——重跑 `mac_ax_state` / `browser_snapshot` 并用新索引 |
| `occluded: … — on top: {…}` | 物理点击会落在别的东西上（另一个窗口、一个 sheet）——把目标窗口置前或关掉遮挡物；本次什么都没发送 |
| `ambiguous_window: … windows: […]` | 该应用有多个窗口且没有一个处于焦点——传 `window`（序号或标题）或 `mac_windows` 给出的 `window_id` |
| `policy_denied: "cmd-q" …` | `mac_key` 拒绝退出 / 注销 / 锁屏 / 强制退出 / 立即删除 / 清空废纸篓类组合键，除非传 `force: true`；要退出应用请用 `mac_app` |

启动时拒绝 Node 18——请用 Node ≥ 20。Claude Desktop 可能为每个使用面各起一个 noracu 进程；它们共享浏览器 profile，所以同一时间只从一个面启动浏览器。

完整实操示例见 [docs/usage.md](docs/usage.md)（英文）。

## iPhone 层（实验性）

noracu 可以经 Apple 的 **iPhone Mirroring** 操作真实 iPhone。这一层默认关闭：在 server 条目里加上 `"env": { "NORACU_LAYERS": "mac,browser,iphone" }`（只带 iPhone 工具的条目写 `iphone` 即可），然后完全退出宿主并重开。agent 在 Mac 上用 OCR 观察（`phone_screenshot`、`phone_ocr`、`phone_find`），按 0–1 归一化坐标动作（`phone_tap`、`phone_swipe`、`phone_scroll`），用粘贴输入文字（`phone_type`），按名字打开 App（`phone_open`）。这不是 `element_index`：手机不向 Mac 暴露 accessibility 树，所以点击落在 OCR 识别出文字的位置。驱动（imctl，Python，MIT，约 3,500 行）随包附带在 `imctl/`。

**它会占用 Mac 的鼠标和键盘。** iPhone Mirroring 是 Mac 上的一个窗口，所以每个手机输入都经过 Mac：iPhone Mirroring 被调到最前，点按和滑动用的是真实指针，`phone_type` 用 ⌘V 粘贴。手机步骤进行时别用这台 Mac——最近 2 秒内用过键盘或鼠标时 noracu 会拒绝（`user_active`，什么都不发；停手后重试），事后把指针放回原处，但最前面的窗口会变。下面的 XCUITest 后端不用 Mac 的指针和键盘。

**Apple 的要求**（[support.apple.com/120421](https://support.apple.com/120421)）：搭载 Apple 芯片或 T2 芯片、运行 macOS 15 或更高版本的 Mac；运行 iOS 18 或更高版本并设置了密码的 iPhone；两台设备登录同一个开启双重认证的 Apple 账户；蓝牙和 Wi-Fi 打开；Mac 没有共享互联网连接、没有使用 AirPlay 或随航（Sidecar）。**iPhone 必须锁定并靠近 Mac**——解锁 iPhone 或退出 iPhone Mirroring 都会结束会话。iPhone Mirroring 目前在欧盟不可用。一次只能一台 Mac 和一台 iPhone；摄像头和麦克风不会被镜像。

**无人值守：** 在 iPhone Mirroring → 设置里选「自动认证（Authenticate automatically）」，会话开始时就不再要求输入密码。代价：任何能使用你这台已解锁 Mac 的人都能打开你的手机。

**Python：** 驱动需要一个能导入 pyobjc（Quartz、Vision、AppKit）的 python3。设置 `NORACU_PYTHON`，或由 noracu 在首次调用 `phone_*` 时依次探测一次 `/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`python3`、`/usr/bin/python3`。Apple 自带的 `/usr/bin/python3` 通常没有 pyobjc；常见可用配置是 Homebrew 的 python3 加 `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa`。

**镜像状态：** `phone_status` 返回 `live`（手机画面正在推流）、`overlay`（iPhone Mirroring 显示的替代文字，如 "Connection Paused"、"iPhone in Use"）、`paused`（该覆盖层带 Resume 按钮）和 `setup`（需要用户自己完成的设置或欢迎页——noracu 从不点击）。判定依据是窗口结构和形状（镜像窗口是竖长或横长的手机形状，设置页接近正方形），不是文字。镜像不在线时，所有手机输入工具（`phone_tap`、`phone_longpress`、`phone_swipe`、`phone_scroll`、`phone_type`、`phone_key`、`phone_open`、`phone_home` 和 `phone_app_switcher`）都会以 `mirror_not_live` 拒绝——在镜像已暂停或未开启时不会先抢焦点——而不是点到覆盖层上；状态仍无法判定时以 `mirror_state_unknown` 拒绝（`phone_ocr` / `phone_find` 的输出首行会给出警告）。镜像闲置一段时间后会暂停；`phone_launch` 会把它置前并点击 Resume。

**隐私：** 手机上显示的一切——通知、短信、邮件、一次性验证码——都会变成工具输出，由你的 MCP client 发给它所用的模型。开始前打开专注模式、打开一个无关紧要的 App，并先用 `NORACU_READ_ONLY=1`（`phone_status`、`phone_screenshot`、`phone_ocr`、`phone_find` 仍可用；所有手机输入都会被拒绝）。iPhone Mirroring 设置好后，iPhone 的通知也会出现在 Mac 上。「看」这个动作对手机也不是隐形的：一次真机测试中（iPhone 17 Pro Max 运行 iOS 27，Mac 运行 macOS 27.2），每次截取镜像窗口后一到四秒，LinkedIn 和小红书都弹出了各自的「截屏后分享」面板，截一次多一层。凡是读屏幕的工具都会截取——`phone_screenshot`、`phone_ocr`、`phone_find`、任何 `expect` 检查，以及 `phone_type`、`phone_open`、`phone_scroll` 内部的检查；手机输入若要先把 iPhone Mirroring 切到前台，也会截一次。会记录截屏、或把截屏告诉聊天对方的 App，应当假定每次截取都会触发（未测试）。

**首次成功路径：** `phone_status` → 若 `live` 不是 `true` 先 `phone_launch` → `phone_screenshot` → `phone_ocr` → `phone_find` + `phone_tap`。

**已知限制：** 点击落在 OCR 识别到文字的位置，重复或识别错的标签可能点错（若 Spotlight 的「Top Hit」里是同名的联系人或网站，`phone_open` 分辨不出它不是 App）；`phone_scroll` 用触控板式的滚动事件移动列表（竖向的 `phone_swipe` 拖拽不会滚动列表——它用于主屏翻页这类手势，起点放在 Dock 上方的空白带：起点落在 App 图标上的拖动会把图标拿起来挪走；划动的两个点都会被限制在手机屏幕内，因为起点或终点落在屏幕外围透明窗口边框上的拖动会被 iOS 取消，被挪动的点会在结果里写明；点按或长按若落在这圈边框上——屏幕上方那一条放的是窗口自己的控件——会被拒绝并返回 `out_of_screen`；屏幕边界只截取窗口一次来测量，按窗口尺寸和 macOS 版本记在 `~/Library/Caches/noracu/phone-screen-rect.json` 里，指针停在那一条上时测到的结果不可信、不会采用，在测到干净结果之前，凡是落在窗口顶部或四周一圈（可能是边框的地方）的点：点按和长按会被拒绝，划动的点会被往里挪，结果里都会写明）；在一套实测环境（iPhone 17 Pro Max 运行 iOS 27.0.1，Mac 运行 macOS 26.6.2）上，iPhone Mirroring 在所有 View 尺寸下都把手机画面画得比窗口大约 17%，右列和最底行被裁掉、无法点到；在显示器之间移动窗口、切换主屏、重开 App 都无效，主要怀疑是 iOS 27 与 macOS 26 版本错位——边缘附近点不中时先看 `phone_screenshot`；`phone_open` 把 App 名输入 Spotlight，只有当 Spotlight 的「Top Hit」卡片显示的正是这个名字时才点击——若 Spotlight 把搜索框放在顶部、没有「Top Hit」卡片（iOS 27 上见过），则只在搜索框把这个名字补全成「<名字> — Open」时才点（同名的网页建议、网站和设置行一律不点），否则回到主屏——它读的是 Spotlight 的英文 "Top Hit" 标签，iPhone 设为其他语言时找不到任何 App，除非用 `NORACU_TOPHIT_LABELS` 指定那个标签（顶部搜索框布局里的「Open」补全只认英文，`NORACU_TOPHIT_LABELS` 管不到它）；`phone_home` / `phone_app_switcher` 在镜像在线时走 iPhone Mirroring 菜单（英文 macOS 下无需 python，仅在菜单项不存在时回退 `imctl` 手势，菜单超时返回 `menu_unknown` 而不补发第二次手势），且只报告指令已发送（`screen not verified`）；`phone_type` 要求 Mac 键盘布局里 A 和 V 的位置与美式 QWERTY 相同（美式、ABC、拼音都满足；法式 AZERTY、Dvorak 不满足），否则返回 `keyboard_layout`，什么都不发；手机经「通用剪贴板」读取 Mac 的剪贴板，新内容要过一会儿才通知到手机，所以 `phone_type` 在写入剪贴板后至少等 1.5 秒再发 ⌘V（这期间若有别的 App 切到前台，就返回 `focus_lost`，不发 ⌘V）——一次真机测试中，写入后约 0.5 秒就发出的 ⌘V 贴出了手机自己的旧剪贴板（上一次粘贴的内容），粘贴也可能在手机显示「Pasting from …」后中断；收到 `type_not_confirmed` 后，先读输入框再重打。

### XCUITest 后端（实验性，需显式开启）

在 iPhone 层打开（`NORACU_LAYERS` 写了 `iphone`）的前提下，设置 `NORACU_PHONE_BACKEND=xcuitest` 后，noracu 列出 9 个 `ios_*` 工具，取代 `phone_*`。它们不经过 iPhone Mirroring 窗口：一个很小的 UI 测试包（"runner"——Swift，MIT，源码在 `ios-runner/`）跑在 iPhone 上，一次执行一条指令。agent 读取 App 自己的辅助功能元素（`ios_snapshot`），按 `element_index` 动作（`ios_tap`、`ios_type`），坐标是屏幕点而不是 OCR 位置。App 按 bundle id 打开（`ios_launch`）；文字以键盘输入的方式打进去，不经过剪贴板，只有事后读到接收文字的那个文本框的内容正好是原来的内容加上这段文字、且加在一处（至少 4 个字符），`ios_type` 才报 `delivered_verified`。

**要求：** Xcode（完整版）；一个用来给 runner 签名的 Apple 开发者 team；一台已与本机配对、开了开发者模式的 iPhone——用数据线或同一局域网均可——或者一台已启动的模拟器。使用这些工具时 **iPhone 必须是解锁状态**（与 iPhone Mirroring 相反，后者要求锁屏）：锁着的手机返回 `device_locked`：不发任何输入，也不读快照或截图。

**每台设备做一次的准备：** `npx noracu ios-setup --team <TeamID>` 把 runner 构建到 `~/.noracu/ios-runner/<udid>`（连着多台 iPhone 时加 `--udid`；模拟器只需要 `--udid`）。这是一条要你自己运行的命令——安装时什么都不会构建——也是这个后端唯一会联网的一步：Xcode 用你的 team 给 runner 签名，可能为它创建一份开发用描述文件；只有加了 `--register-device` 才会把 iPhone 登记到 team 里。之后用 `NORACU_PHONE_BACKEND=xcuitest` 启动 server。升级 noracu 之后，如果调用返回 `runner_version_mismatch`，就重新运行一次这条命令：用别的版本的源码构建的 runner 不会被使用。

**首次成功路径：** `ios_status` → `ios_launch`（`com.apple.Preferences`）→ `ios_snapshot` → 按 `element_index` 调 `ios_tap` 或 `ios_type` → 再 `ios_snapshot`。第一个需要用到手机的调用会启动 runner（iPhone 16 Pro 上约 9 秒；模拟器热了之后约 2 秒，刚启动时接近半分钟）；需要先启动 runner 的输入调用什么都不发，因为 runner 自己的 App 会切到前台——先用 `ios_snapshot` 看。server 退出时会把 runner 停掉。

**与 Mirroring 后端的区别：** 给的是带 `element_index` 的元素，而不是 OCR 文字；索引在使用前会复核（元素移动了、变了，或它的 App 不在前台了，就返回 `element_no_longer_valid`），`ios_home` 和 `ios_launch` 会让之前的索引全部失效；App 用 bundle id 指名，noracu 只知道调用里指名的那个 App 是否在前台。`NORACU_STOP_FILE`、`NORACU_DENY_APPS`、`NORACU_APPROVAL_FILE` 照常生效——按 iOS 的 bundle id 匹配；默认的禁用名单只列了 Mac 上的应用（终端应用和自带终端的 IDE），所以默认不会挡住任何 iOS App；有 App 规则生效时（`NORACU_APPROVAL_FILE` 或你自己的 `NORACU_DENY_APPS`），指向主屏幕（`com.apple.springboard`）的输入一律拒绝，即使它列在 `allow` 里（打开已批准的 App 请用 `ios_launch`）——`NORACU_USER_IDLE_S` 不生效，因为这些工具不使用 Mac 的键盘和鼠标。iPhone 上弹着系统提示（权限弹窗）时，指向 App 的输入一律不发（`system_alert`），由人在手机上处理。

**隐私：** `ios_snapshot` 和 `ios_screenshot` 会把 App 上显示的内容——消息、通知、一次性验证码——交给你的 MCP client 和它所用的模型，和 Mirroring 后端一样。在 `NORACU_READ_ONLY=1` 下，这个后端只回答 `ios_status`：所有手机输入都会被拒绝，`ios_snapshot` / `ios_screenshot` 返回 `runner_not_started`——读屏幕需要 runner，而启动 runner 会把它自己的 App 切到前台，盖住手机上原来的画面。

**测试环境：** iPhone 16 Pro（iOS 27.2）与 iPhone 17 Pro 模拟器（iOS 26.5），Xcode 27.2，在「设置」和主屏幕上测过。真机上每次输入因为要查锁屏状态会多花约 0.8 秒；距上次检查超过 1 秒的快照或截图也一样。没测过的情况写在 CHANGELOG 的 Known issues 里；这个后端的风险见 [SECURITY.md](SECURITY.md)。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `NORACU_READ_ONLY` | 未设 | `=1` 只观察模式：默认拒绝的白名单只含观察 + 浏览器生命周期工具——8 个 `mac_*`、6 个 `browser_*`，开了 iPhone 层时再加 4 个观察类 `phone_*`（XCUITest 后端下换成 `ios_status`、`ios_snapshot`、`ios_screenshot`；`ios_snapshot`、`ios_screenshot` 会以 `runner_not_started` 被拒，因为只观察模式不启动 runner）；所有 click/type/paste/key/eval 类工具被拒（`mac_clipboard_read`、`mac_notifications` 以及 `condition: "notification"` 的 `mac_wait` 也被拒；`mac_ax_state` / `mac_find` 也不开启 `web_accessibility`） |
| `NORACU_ENABLE_EVAL` | 未设 | `=1` 开启 `browser_evaluate`（在页面里跑任意 JS）；未设时调用返回 `eval_disabled`（仍在列表中） |
| `NORACU_DISABLE_EVAL` | 未设 | `=1` 即使设了 `NORACU_ENABLE_EVAL=1` 也让 `browser_evaluate` 保持关闭（熔断开关） |
| `NORACU_ALLOW_FILE_URL` | 未设 | `=1` 允许 `browser_navigate` 打开 `file://` URL（默认封禁） |
| `NORACU_DISABLE_AUTO_INSTALL` | 未设 | `=1` 跳过首次 `browser_launch` 的 Chromium 自动安装 |
| `NORACU_ALLOW_CHROME` | 未设 | `=1` 允许 `browser_launch` 带 `chrome: true` 在你自己的 Chrome 里干活、用它的登录态：走 Chrome 自带的远程调试开关（`chrome://inspect/#remote-debugging`，Chrome 144 起；每次连接 Chrome 都会弹窗问你）。noracu 在里面开一个自己的窗口，只在它自己开的标签里干活；`NORACU_READ_ONLY=1` 下拒绝 |
| `NORACU_CHROME_TABS` | 未设（只碰 noracu 自己的标签） | `all`：带 `chrome: true` 时，你自己的其他标签也会列出来，可以选中、读取和操作（只限 http(s) 页面）；只关 noracu 自己开的标签 |
| `NORACU_CHROME_DIR` | `~/Library/Application Support/Google/Chrome` | `chrome: true` 读取 `DevToolsActivePort` 文件的资料目录（Chrome Beta、Canary 或其他 Chromium 系浏览器） |
| `NORACU_ALLOW_CDP` | 未设 | `=1` 允许 `mac_app` 带 `cdp_port` 启动，并允许 `browser_launch` 连接由本 `noracu` 进程打开的 `cdp_port`（需对应 PID 存活且 `webSocketDebuggerUrl` 一致）；`=any` 还允许 `browser_launch` 连接 127.0.0.1 上的任意外部 DevTools 端口（在 `NORACU_READ_ONLY=1` 下始终拒绝） |
| `NORACU_TRACE` | 未设 | 一个文件路径：每次工具调用写一行 JSON（`{ts, tool, args, ms, error, code}`——仅记录参数名与长度及错误码前缀，从不记录参数文本、结果文本或错误详情；以 `0600` 和 `O_NOFOLLOW` 打开，拒绝符号链接） |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick 二进制路径 |
| `NORACU_PYTHON` | 自动探测 | 运行随包 iPhone 驱动的 python3；须能导入 pyobjc（Quartz、Vision、AppKit）。未设置时依次尝试 `/opt/homebrew/bin/python3`、`/usr/local/bin/python3`、`python3`、`/usr/bin/python3` |
| `NORACU_IMCTL_DIR` | 包内 `imctl/` | 覆盖驱动位置（仅开发用） |
| `NORACU_PHONE_TIMEOUT_MS` | 30000（`phone_open` / `phone_type` 为 45000） | iPhone 层每一步的时限，1000–600000 毫秒；到时该步被终止并返回 `imctl_timeout` |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | 识别 iPhone 画面的 OCR 语言及优先顺序（逗号分隔的 Vision 语言代码，如 `zh-Hant,en-US` 或 `en-US`；Vision 不支持的代码会被跳过并给出警告） |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | `phone_open` 要找的 Spotlight「Top Hit」分区标签，逗号分隔——iPhone 不是英文时，设成手机上实际显示的那个标签 |
| `NORACU_OCR_MIN_CONFIDENCE` | 未设（关闭） | 可选、实验性：大于 0 且不超过 1 的数。设了以后，`phone_open` 不点识别置信度低于它的 Spotlight 标签，返回 `open_not_confirmed`、什么都不点；设了但不是这样的数，`phone_open` 会直接拒绝（`invalid_args`，什么都不发）。不管设没设，`phone_open` 的结果行都会写出所点标签的识别置信度 |
| `NORACU_USER_IDLE_S` | `2` | Mac 或 iPhone 输入工具动作前，键盘和鼠标须已空闲的秒数（noracu 自己的输入不算）；不到就返回 `user_active`、什么都不发。不为 0 时，物理点击、拖动、滚动和手机手势之后指针还会回到原处，除非这期间有人动过它。取值 0–60；`0` 两项都关（专给 agent 用的 Mac）；其他值按 2 处理。`ios_*` 工具不等待：它们不使用这台 Mac 的键盘和鼠标 |
| `NORACU_NO_BGPOST` | 未设 | `=1` 关闭后台输入：物理点击和具名按键像 0.2.7 一样走真实指针和 HID 按键路径 |
| `NORACU_PHONE_BACKEND` | `mirror` | 设为 `xcuitest` 时列出 `ios_*` 工具（XCUITest 后端，实验性）而不是 `phone_*`；其他值按 `mirror` 处理，并在 stderr 上给出警告 |
| `NORACU_IOS_UDID` | 未设 | XCUITest 后端使用的 iPhone 或模拟器；连着多台 iPhone 时必须设置，模拟器始终需要 |
| `NORACU_IOS_RUNNER_DIR` | `~/.noracu/ios-runner` | `noracu ios-setup` 放置 runner 构建产物、server 查找它的目录 |
| `NORACU_LAYERS` | 未设（`mac,browser`） | 逗号分隔的 `mac`、`browser`、`iphone`：只列出这些层的工具，也只有它们能被调用——实验性的 iPhone 层只在写了 `iphone` 时才有（`NORACU_LAYERS=mac,browser,iphone`），`initialize` 的使用说明也只提它们（例如给只带 iPhone 工具的客户端入口设 `NORACU_LAYERS=iphone`）；写了这三个以外的名字，server 启动即退出 |
| `NORACU_STOP_FILE` | 未设 | 一个文件路径：该文件存在期间，所有输入工具——Mac（`mac_*`）、iPhone（`phone_*`、`ios_*`）和浏览器输入（`browser_navigate`、`browser_click`、`browser_type`、`browser_fill`、`browser_press_key`、`browser_scroll`、`browser_evaluate`、`browser_tabs` 的 new/close）——都返回 `user_stopped`，什么都不发；观察类工具不受影响 |
| `NORACU_DENY_APPS` | 常见终端应用和自带终端的 IDE | 逗号分隔的 bundle id 或应用名（可用 `*` 和 `?` 通配），这些应用永不接收输入；列表是加在默认列表上的——留空保持默认列表，以 `none` 开头则去掉默认列表（只写 `none`：没有禁用名单；`none,com.example.app`：只禁这一个） |
| `NORACU_APPROVAL_FILE` | 未设 | 一个 JSON 文件 `{allow, ask, deny}`，内容是 bundle id / 应用名的匹配模式，权限须为 `0600` 且属于你本人；列在 `ask` 下或未列出的应用返回 `approval_required`；一旦设置，文件不存在、格式错误、是符号链接、有未知字段、组可读或属主不对时，拒绝一切 Mac 与 iPhone 输入（应用规则不管浏览器层）；把它设成空值也一样，直到删掉或填上路径；`NORACU_STOP_FILE` 设成空值则拒绝一切输入，浏览器输入也在内 |

## 安全

noracu 以你 MCP client 的权限运行。它会在本机点击、输入、粘贴、驱动真实浏览器——没有沙箱，没有远程确认弹窗。请在 server 条目上设好下面这些，然后完全退出宿主并重开：

```json
"env": { "NORACU_READ_ONLY": "1", "NORACU_DISABLE_EVAL": "1" }
```

- **工具注解只是提示，不是权限。** 每个工具都报告四个 MCP 工具注解（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`），按工具实际行为标注——见 [docs/tools.md](docs/tools.md)。客户端可以据此决定哪些操作先问你；它们不限制任何事，而且按 noracu 应答的 2024-11-05 协议工作的客户端可能直接忽略。它们也不等同于 `NORACU_READ_ONLY=1`：`mac_clipboard_read` 按行为是只读，但在该模式下被拒；`browser_navigate` 在该模式下允许，却不是只读。
- **`NORACU_READ_ONLY=1`** 是安全的首次运行模式。它拒绝不在 18 项白名单内的一切工具（观察类 + 独立的 `browser_launch`/`browser_navigate`/`browser_close`；即使设了 `NORACU_ALLOW_CDP`，带 `cdp_port` 的 `browser_launch` 也会被拒）；所有 click/type/paste/eval 被拒，`mac_clipboard_read`、`mac_notifications` 和 `condition: "notification"` 的 `mac_wait` 也被拒，且 `mac_ax_state` 与 `mac_find` 不会在目标应用上开启 `web_accessibility`。`browser_navigate` 在白名单内，仍会加载 URL。
- **`browser_evaluate` 默认关闭。** 它能在页面里跑任意脚本，所以除非 server 启动时设了 `NORACU_ENABLE_EVAL=1`，否则返回 `eval_disabled`；设了 `NORACU_DISABLE_EVAL=1` 时即使开启也照样关闭。它仍列在 `tools/list` 中。snapshot、click、type 保留。
- **`file://` 被拒**，除非 `NORACU_ALLOW_FILE_URL=1`，这样浏览器 agent 无法通过导航到 `~/Documents` 来读本地文件。（导航中浏览器自己可能跟随重定向，但之后的每次工具调用、以及进行中的读取和快照，都会重新检查当前页的地址，不合规则就拒绝——见 SECURITY.md。）
- **焦点守卫：** 给 `mac_paste` / `mac_key`（以及以按键方式输入时的 `mac_type`）传 `app`，当该应用不在最前时输入被拒。不传 `app` 则守卫关闭。`mac_type` 默认走辅助功能写入指定元素或该应用的焦点元素，根本不发按键；只有焦点是辅助功能写不进的文本视图（如终端）时才退回到发按键，焦点是按钮、列表或 sheet 时不会；应用报告没有焦点元素时，只有 `app` 指明该应用才发按键（否则返回 `no_focus`，什么都不发）。
- **失效元素保护：** `element_index` 不是坐标。它 30 秒后过期；Mac 上的索引不会被之后的快照复用。Mac 元素只在它被看到的那个窗口或打开的菜单里重新识别（按窗口 ID），并且要在窗口里的同一位置、同样的有名祖先之下、同一表格行中；没有名称也没有标识符的元素必须仍在原处。用 `surface: "app"` 读到的元素同样绑定所在窗口的 ID；没有窗口 ID 的窗口（Finder 桌面除外）一律以 `policy_denied` 拒绝，所以关掉再重开的同内容窗口不会继承旧索引。browser 点击重校验 tag/name/href/位置。否则返回 `element_no_longer_valid`。
- **物理点击前做命中检测：** 必须用指针的 Mac 点击或拖动，只有该点上的元素就是目标时才发送——辅助功能无法判断时，要求该点最上层的屏幕窗口正是元素所在的同一个窗口（按窗口 ID，未被同一应用的另一个窗口遮挡）；否则返回 `occluded` 并说明上面是什么。点击发出前会再查一次该点最上层的窗口；发出后，只有元素仍在、状态有变化、且该点最上层仍是元素自己的窗口，结果才是 `delivered_verified`。按原始坐标 x,y 点击时，只有该点最上层的屏幕窗口属于 `app`（默认为前台应用；菜单栏算前台应用的）才发送；`force: true` 跳过这项检查。这样的点击之后再敲的键，只在元素所在应用确实位于前台时才发送。
- **后台窗口：** 语义 Mac 动作对你没在看的窗口同样有效。这正是目的（不抢焦点），但也意味着 agent 可能在你看不到的地方动作——留意结果里的 `delivery`，高风险应用请先关掉。
- **后台点击与按键（bgpost）：** 在 `mechanism: "auto"` 下，对原生应用的物理点击、以及发给位于前台的原生应用的具名按键，会直接投递到该应用的进程——指针不动，你可能看不到它发生。网页引擎应用（Chromium/Electron）和 `mechanism: "physical"` 用真实指针；结果里的 `route` 写明走了哪条路。投递出去的点击绝不会换一条路再发一次：看不到变化报 `delivered_unverified`，超时报 `delivery=unknown`。`NORACU_NO_BGPOST=1` 可关闭此功能。
- **停止、拒绝、审批：** `NORACU_STOP_FILE` 指定的文件存在期间，所有输入工具都返回 `user_stopped`，什么都不发——Mac（`mac_*`）、iPhone（`phone_*`、`ios_*`）和浏览器输入（`browser_navigate`、`browser_click`、`browser_type`、`browser_fill`、`browser_press_key`、`browser_scroll`、`browser_evaluate`、`browser_tabs` 的 new/close）；观察类工具不受影响（`touch` 该文件即停，删掉即恢复）。`NORACU_DENY_APPS` 列出永不接收输入的应用——默认是常见终端应用（Terminal、iTerm2、WezTerm、Ghostty、Warp、Alacritty、kitty、Hyper）和自带终端的 IDE（VS Code、Cursor、Windsurf、Zed、JetBrains 系 IDE、Android Studio，含预览版和每夜版；名字 `Code` 和 `com.jetbrains.*` 也会拦下恰好叫 Code 的应用和 JetBrains Toolbox），防止 agent 往这些 shell 里打字（其他能跑 shell 的应用不在列表里）；你自己的列表会加在它上面，以 `none` 开头则去掉它。`NORACU_APPROVAL_FILE`（需显式开启）指向一个权限为 `0600` 的 JSON 文件 `{ "allow": [...], "ask": [...], "deny": [...] }`，内容是 bundle id 或应用名的匹配模式：列在 `ask` 下或未列出的应用返回 `approval_required`，noracu 从不写这个文件；一旦设置了该变量，文件不存在或损坏时拒绝一切 Mac 与 iPhone 输入（浏览器层不按应用规则判断，停止文件能停住它）。只要其中一条规则生效，读不到 bundle id 的应用什么都收不到。每项检查都按接收输入的那个应用判断——元素所属的应用、指定的应用，或 x,y 点上最上层的应用——无法识别是哪个应用时什么都不发。这些文件挡的是模型，挡不住以你的身份运行的其他软件：见 SECURITY.md。
- **危险按键、菜单与退出受保护：** `mac_key` 拒绝退出 / 注销 / 锁屏 / 强制退出 / 立即删除 / 清空废纸篓类组合键，除非 `force: true`；`mac_menu_command` 对菜单快捷键应用同一列表，且拒绝苹果菜单项，除非 `force: true`。`mac_app` 和 `mac_menu_command` 都从不退出 Finder、Dock、loginwindow 等会话进程和 MCP 宿主本身；`mac_app` 强制退出需要 `force: true`。
- **用你自己的 Chrome 需显式开启：** `browser_launch` 带 `chrome: true` 需要 `NORACU_ALLOW_CHROME=1`，以及 Chrome 自带的远程调试开关（`chrome://inspect/#remote-debugging`）；每次连接 Chrome 都会弹窗问你，连着时页面顶部有横幅。noracu 会在你的 Chrome 里开一个自己的窗口，只列出、读取和操作它自己开的标签（以及这些标签再打开的标签）；noracu 不列出、不读取、不操作你的其他标签（除非另设 `NORACU_CHROME_TABS=all`：那时你停在 http(s) 页面上的标签也会列出来，可以选中、读取和操作——`file://` 和浏览器自带页面不算，不管 `NORACU_ALLOW_FILE_URL` 怎么设；它们不会被关闭，也不会被导航到非 http(s) 地址；只有选中后才成为当前页，离开 http(s) 就不再是当前页）；noracu 自己的标签照旧按网址规则（只认 http(s)；`file://` 要 `NORACU_ALLOW_FILE_URL=1`）。这些标签带着你的登录态，agent 在里面操作就等于以你的身份在这些网站上操作；`browser_evaluate` 在这里一律不跑。`browser_close` 关掉 noracu 的标签并断开；noracu 从不退出 Chrome。`NORACU_READ_ONLY=1` 下拒绝。
- **DevTools 端口需显式开启：** `mac_app` / `browser_launch` 带 `cdp_port` 需要 `NORACU_ALLOW_CDP=1`（连接非 `noracu` 自己打开的端口需 `NORACU_ALLOW_CDP=any`；`NORACU_READ_ONLY=1` 下始终拒绝），只绑定 127.0.0.1，规范化 `.app` 路径，拒绝已在运行的应用和应用规则（拒绝名单、审批文件）不允许的应用，且在 `~/.noracu/cdp-profiles` 下给 Chrome 系浏览器单独的 `0700` profile。端口打开期间，任何本地进程都能控制该应用（127.0.0.1 没有按用户隔离）。
- **剪贴板、密码框和通知属于隐私：** `mac_paste` 会把用户原来的剪贴板（所有条目和类型）放回去，且从不复制密码管理器标记为隐藏的内容——粘贴后改为清空剪贴板；`mac_clipboard_read` 从不返回隐藏内容；`mac_set_value` 作用于安全密码框（`AXSecureTextField`）时从不回显值；`mac_notifications` 原样返回通知文字。`mac_clipboard_read`、`mac_notifications` 以及等待通知的 `mac_wait` 在只读模式下均被拒绝。
- **iPhone 画面就是模型输入：** `phone_screenshot` / `phone_ocr` / `phone_find` 会返回手机上显示的一切——通知、短信、一次性验证码。请用专注模式和无关紧要的 App，并先用 `NORACU_READ_ONLY=1`（允许观察手机、拒绝手机输入）。镜像不在线（`mirror_not_live`）或状态无法读取（`mirror_state_unknown`）时，手机输入同样会被拒绝。
- **防注入 JXA 与 stdin 传参：** 辅助功能引擎（`src/mac-ax.js`）是静态脚本，整条请求以 JSON 从 stdin 传入——参数只是数据，从不成为脚本源码——且 `mac_type`（默认路径）、`mac_set_value`、`mac_paste` 以及 `phone_type` / `phone_find` / `phone_open` 都经 stdin 传入文字，不会出现在进程列表里（`imctl type` 也不回显文字）。有回归测试覆盖。

**默认拒绝的事**——被拒的输入什么都不发，报错里会写明（`delivery=not_delivered, retry=safe`）：

| 默认拒绝 | 返回 | 怎么改 |
|---|---|---|
| 往终端和自带终端的 IDE 里输入 | `input_denied` | `NORACU_DENY_APPS`（以 `none` 开头去掉默认列表） |
| `browser_evaluate`（在页面里跑任意脚本） | `eval_disabled` | `NORACU_ENABLE_EVAL=1` |
| 浏览器打开 `file://` 页面 | 在 URL 上拒绝 | `NORACU_ALLOW_FILE_URL=1` |
| DevTools 端口（`cdp_port`） | 拒绝 | `NORACU_ALLOW_CDP=1` |
| 在你自己的 Chrome 里干活（`browser_launch` 带 `chrome: true`） | `policy_denied` | `NORACU_ALLOW_CHROME=1`，并在 `chrome://inspect/#remote-debugging` 打开 Chrome 的开关 |
| iPhone 工具 | 不列出；调用时返回 `unknown tool … the iphone layer is off` | `NORACU_LAYERS=mac,browser,iphone` |
| 你在用键盘或鼠标时的 Mac 输入和 iPhone Mirroring 输入 | `user_active` | `NORACU_USER_IDLE_S=0` |
| 退出、注销、锁屏、强制退出、立即删除、清倒废纸篓的快捷键；苹果菜单里的项 | 拒绝 | `force: true` |
| 停止文件存在期间的所有输入——前提是你用 `NORACU_STOP_FILE` 指定了一个 | `user_stopped` | 删掉该文件 |

这些开关不会让被观察的内容变得可信。截图文字、accessibility 名称、页面内容都是喂给你模型的**不可信输入**——别让它们覆盖任务指令。完整威胁模型与逐条状态见 [SECURITY.md](SECURITY.md)（英文）。

## 工具与文档

- 完整工具参考：[docs/tools.md](docs/tools.md)（由运行中的 server 自动生成）
- 使用实操：[docs/usage.md](docs/usage.md)
- 架构：[docs/architecture.md](docs/architecture.md)

## 路线图

- 动作词汇（browser）：`hover`、`set_value`、`wait_for`
- 测量 `skeleton` + `root` 下钻相对完整快照的 token 消耗
- 菜单栏时钟不对辅助功能可见时，也能打开通知中心的历史列表
- iPhone：在 OCR 区域上提供 `element_index`，点击前重新校验文字

## 维护

个人维护，无 SLA。Mac 层需 macOS 15+；iPhone 层另需 Apple 芯片或 T2 的 Mac、iOS 18+ 和 iPhone Mirroring（欧盟不可用）；Browser 层随 Playwright 跨平台。

## 许可

MIT——见 [LICENSE](LICENSE)。
