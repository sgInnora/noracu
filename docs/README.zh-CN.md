# noracu

**一个跑在本机的 MCP server：让 MCP 客户端（Claude Desktop、Claude Code、Cursor 等）按 `element_index`
操作 macOS 应用和浏览器，并且说清楚每个动作做成了没有。不需要 API key，没有遥测。**

English: [README.md](../README.md)。下面链接到的文档目前是英文的。

![noracu 演示](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-demo.gif)

*在你自己的 Chrome 里，noracu 打开一个标签页，从页面上读一个数字，再把它打进"备忘录"的一条新笔记。
用你自己的 Chrome 要手动开启：`NORACU_ALLOW_CHROME=1`，加上 Chrome 的远程调试开关（见 [usage.md](usage.md) 第 5b2 节）；
不开的话，浏览器层用它自己的配置目录。*

## 它做什么

| 层 | 工具 | 靠什么 | 状态 |
|---|---|---|---|
| **Mac** | 20 个（`mac_*`） | macOS 辅助功能 API、cliclick、screencapture | 稳定 |
| **浏览器** | 13 个（`browser_*`） | Playwright：它自己的配置目录，或你的 Chrome（要手动开启：`NORACU_ALLOW_CHROME=1` 加 Chrome 的远程调试开关） | 稳定 |
| **iPhone**（镜像） | 14 个（`phone_*`） | Apple 的"iPhone 镜像"，在 Mac 上做 OCR | 实验性，默认关 |
| **iPhone**（XCUITest） | 9 个（`ios_*`） | 手机上的一个 UI 测试 runner，用 Xcode 构建 | 实验性，默认关 |

代理先取一份快照（Mac 上是辅助功能树，浏览器里是 ARIA 树），拿到带编号的元素列表，再按 `element_index`
操作。树不够用时可以截图。

## 快速开始

**1. 安装**（Node ≥ 20；没有 postinstall 脚本），装在一个你会留着的文件夹里：

```bash
npm install noracu          # server 在 node_modules/noracu/src/server.mjs
brew install cliclick       # Mac 上的物理输入要用（按键、拖拽、需要动指针的点击）
npx noracu --doctor         # 检查这台机器，并打印出给客户端用的配置
```

**2. 加到你的 MCP 客户端。** 粘贴 `--doctor` 打印出的内容，别用下面手写的：它用的是这台机器上的绝对路径，指向你刚装的
那一份——Claude Code 是一条命令（`-s user` 表示对你所有项目生效），Claude Desktop 和 Cursor 是一段 JSON。
手写的话是下面这样。

Claude Code（从终端启动，`PATH` 里有 Node）：

```bash
claude mcp add noracu -- npx -y noracu
```

Claude Desktop（`~/Library/Application Support/Claude/claude_desktop_config.json`）和 Cursor
（`~/.cursor/mcp.json`）是从程序坞启动的，读不到 shell 的 `PATH`，要写绝对路径（`which node` 给出 node 的路径）：

```json
{
  "mcpServers": {
    "noracu": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/绝对路径/node_modules/noracu/src/server.mjs"]
    }
  }
}
```

然后把客户端完全退出（包括菜单栏图标）再打开。

以前装过？`claude mcp add` 不接受已经被占用的名字：先运行 `claude mcp remove noracu`（当初是对所有项目加的，就加上
`-s user`）。JSON 配置里把 `args` 的路径改成新的。

**3. 把权限给客户端应用，不是给 `node`。** 系统设置 → 隐私与安全性 → **辅助功能** 和 **录屏与系统录音**
（较早的 macOS 上叫「屏幕录制」）→ 打开 Claude Desktop、Cursor 或你的终端。授权后再完全退出、重开一次客户端。

**4. 检查。** 调用 `mac_status`：它会说客户端有没有这两项权限、找没找到 cliclick。再让访达在最前面，调用
`mac_ax_state`（或者传 `app: "Finder"`，不用切到前台），能返回一棵带编号的树就说明通了，点击是之后的事。浏览器：`browser_launch` →
`browser_navigate` → `browser_snapshot` → 带 `element_index` 的 `browser_click`。

**5. 试一下。** 可以对客户端说这三句，都只读不改：

- "调用 noracu 的 `mac_status`，告诉我还缺什么。"
- "用 noracu 读最前面的访达窗口，列出里面有什么。"
- "用 noracu 在浏览器里打开 example.com，告诉我页面的标题。"

不通的话看 [troubleshooting.md](troubleshooting.md)。还是不行，或者某个应用 noracu 读不好、操作不好：
[报告问题](https://github.com/sgInnora/noracu/issues/new?template=bug.yml) 或 [报告一个应用](https://github.com/sgInnora/noracu/issues/new?template=app-report.yml)，都不需要 clone 仓库。

## 它怎么做事

- **按元素操作，不按像素。** `element_index` 指的是上一份快照里的某个元素，30 秒内有效。动手之前会重新确认这个
  元素；不在了或变了，就回 `element_no_longer_valid`。
- **说清发生了什么。** 每个输入结果都带 `delivered_verified`（看到了变化）、`delivered_unverified`、
  `not_delivered` 或 `unknown`，以及重试是否安全。
- **坐在 Mac 前的人优先。** 最近 2 秒里用过键盘或鼠标，Mac 和 iPhone 的输入先把这 2 秒等满一次；那时人还在用，
  就回 `user_active`，什么都不发。
  `NORACU_USER_IDLE_S=0` 可以关掉。
- **关着的开关就是关着。** `NORACU_READ_ONLY=1` 只许观察；`NORACU_STOP_FILE` 指的文件存在时不发任何输入；
  `NORACU_DENY_APPS` 和 `NORACU_APPROVAL_FILE` 决定哪些应用可以收输入（终端和 IDE 默认拒绝）；
  在页面里跑脚本和打开 `file://` 默认关。
- **有一处读会写一个开关。** 读 Electron 或 Chromium 应用（`mac_ax_state`、`mac_find`）时，会试着打开它的网页无障碍
  （`AXManualAccessibility`），让页面出现在树里——Electron 应用接受，Google Chrome 不接受；传 `web_accessibility: false`
  或设 `NORACU_READ_ONLY=1` 就不打开。
- **留在这台机器上。** 用的是你已经登录的浏览器配置和 Mac 应用。除了 Playwright 第一次下载 Chromium，
  noracu 自己不发任何网络请求。工具返回的内容（文字、截图）仍会由你的客户端发给它用的模型。

![坐在 Mac 前的人优先](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-person-goes-first.gif)

*鼠标在用的时候，每次调用都回 `user_active`、不打字；停下 2 秒后继续。*

## 它不防什么

- **骗人的内容。** 屏幕上的文字、辅助功能名称、网页内容会原样交给模型。noracu 不识别假弹窗，也不识别提示注入；
  模型拿它们怎么办由客户端决定。先用 `NORACU_READ_ONLY=1`，并保留客户端对输入类工具的确认。
- **没有沙箱。** noracu 以 MCP 客户端的权限，在你已登录的应用里操作。
- **按应用的规则只管输入。** 拒绝名单和审批文件拦不住 `mac_app` 启动、切到前台或退出名单里的应用，
  也拦不住 `mac_window` 移动它的窗口。
- **Electron 和 Chromium 应用**不接受后台点击，在那里的物理点击会移动指针。它们的页面可以改走 DevTools 端口
  （`cdp_port`，见 [usage.md](usage.md)）。
- **两个 iPhone 层都是实验性的**，各有限制，见 [iphone.md](iphone.md)。

默认值、开关和已知缺口的完整清单在 [SECURITY.md](../SECURITY.md)。已知做不到的事（比如应用的窗口在别的桌面上时读不到），
以及改过但还没在真机上重新跑过的地方，写在 [known-issues.md](known-issues.md)。

## 不做的事

- 不内置模型：noracu 负责观察和操作，做决定的是你的 MCP 客户端。
- Mac 层只面向 macOS，没有 Windows 或 Linux 的桌面层。
- 不做托管服务；没有测量过的比较不写。
- 不执行任意代码，除非你自己打开（`NORACU_ENABLE_EVAL=1`）。

## 文档

- [usage.md](usage.md)：各层的用法示例、环境变量、错误说明
- [tools.md](tools.md)：全部工具和参数（由运行中的 server 生成）
- [troubleshooting.md](troubleshooting.md)：安装和授权问题
- [iphone.md](iphone.md)：两个 iPhone 后端的安装、要求和限制
- [known-issues.md](known-issues.md)：做不到的事，和还没在真机上重新测过的改动
- [apps.md](apps.md)：noracu 实际跑过的应用，以及怎么再报告一个
- [architecture.md](architecture.md)：server、Mac 引擎和各驱动怎么配合
- [SECURITY.md](../SECURITY.md)：noracu 能碰到什么、默认值和开关、威胁模型、怎么报告问题

## 维护

一个人维护，没有 SLA。Mac 层需要 macOS 15 以上；iPhone 镜像层还需要 Apple 芯片或 T2 的 Mac、iOS 18 以上和
"iPhone 镜像"（欧盟不提供）；浏览器层在 Playwright 能跑的地方都能用。只在 Apple 芯片、macOS 27 的 Mac 上做过真机测试（没测到的范围见 [known-issues.md](known-issues.md)）。
带上工具名和复现步骤的问题报告最有用，[问题表单](https://github.com/sgInnora/noracu/issues/new/choose)问的就是这些。

## 许可

MIT，见 [LICENSE](../LICENSE)。
