# P4-regex-probe：.NET Regex 与 JS RegExp 对照 + worker 超时终止证明

> 状态：预研结论，未接入主流程。依赖方：grep 实现（见
> [`tools-and-platform.md`](../tools-and-platform.md) 的「.NET 与 JavaScript 搜索语义差异」）。
> 基线与工具链见下文「方法」。本文件只记录真实探针证据，不预判兼容门是否通过——
> 兼容结论仍须由冻结 conformance matrix + 跨平台 fixture 逐项确认（
> [`operator-guide.md`](../operator-guide.md)「必须停止当前单元并记录的情况」与
> [`tools-and-platform.md`](../tools-and-platform.md)「最小实施顺序与停止条件」第 3 条）。

## 方法

- 固定 C# 基线：`09f4e0816c1b2dc42461e79a968b46e811d3880c`，只经 `git show 09f4e08:<path>` 读取。
- 权威工具源码：`Core/Tools/GrepTool.cs`、`Core/Tools/GlobMatcher.cs`；测试语料
  `Di.Tests/Tools/GrepToolTests.cs`。
- 本机工具链：Node `v24.16.0`、npm `11.13.0`、.NET SDK `10.0.301`（探针程序均以
  `net10.0` 编译，`RegexOptions.CultureInvariant` + 可选 `IgnoreCase`，与 GrepTool 逐字一致）。
- 实验目录：`$TMPDIR/p4-regex-probe/`（仓库外）。全部探针脚本与原始输出保留在该目录。

### 基线 grep 工具的正则用法（从源码确认）

`Core/Tools/GrepTool.cs`（`09f4e08`）：

- `RegexOptions`：**恒为 `CultureInvariant`**；`ignore_case=true` 时加 `IgnoreCase`。无
  `Multiline`、无 `Singleline`、无 `ECMAScript`、无 `Compiled`（用户模式）。
- `literal=true` 时 `effectivePattern = Regex.Escape(pattern)`。
- `new Regex(effectivePattern, options)` —— **没有 TimeSpan 重载**，即引擎无超时（下节实测证明）。
- 逐行匹配：`foreach (var line in File.ReadLines(file)) regex.IsMatch(line)`；
  `File.ReadLines` 按 `\r\n`、`\n`、`\r` 切分，行内不含换行符；尾部换行**不**产生幽灵空行。
- 非法正则：构造函数抛 `ArgumentException`，工具返回 `error: 无效正则表达式: {Message}`。
- 扫描预算 `DefaultScanBudgetSeconds = 60` 在**文件之间**检查，**不会**中断单次 `IsMatch`。

`Core/Tools/GlobMatcher.cs`（`09f4e08`）生成 glob 正则：`^` + `[^/]*`（`*`）、`.*`（`**`）、
`(?:.*/)?`（`**/`）、`[^/]`（`?`）、`Regex.Escape(字面量)` + `$`；选项
`CultureInvariant | Compiled`，Windows 下加 `IgnoreCase`。该生成式全部落在 JS 共同子集内
（见 §glob 兼容性）。

## 对照表：.NET 行为 → JS 行为

JS 默认列 = `new RegExp(pattern, flags)`，flags 取 `i`（当 ignore_case）且**不含** `u/m/s`
（最贴近 .NET 默认选项组合）。凡标注 `(u)` 的行为是加 `u` 标志后的结果。全部行均在本机
实测（`.NET` 结果来自 `dotnet-results.txt`，JS 来自 `js-results.txt` / `js-wb.mjs`）。

### A. Unicode 字符类简写

| 用例 | Pattern | 文本 | .NET | JS（非 u） | 判定 |
|---|---|---|---|---|---|
| `\w` 非 ASCII 字母 | `\w+` | `é猫` | ✓ | ✗ | **不兼容**（JS `\w` 仅 ASCII，即使 `u` 标志也是 ASCII） |
| `\w` ASCII | `\w+` | `abc_123` | ✓ | ✓ | 兼容 |
| `\d` 阿拉伯-印度数字 U+0663 | `\d` | `٣` | ✓ | ✗ | **不兼容**（JS `\d` 仅 `[0-9]`，即使 `u`） |
| `\d` ASCII | `\d` | `7` | ✓ | ✓ | 兼容 |
| `\s` NBSP U+00A0 | `\s` | ` ` | ✓ | ✓ | 兼容（两引擎均把 NBSP 当空白） |
| `\b` Unicode 词边界 | `\bé\b` | `é` | ✓ | ✗ | **不兼容**（JS `\b` 基于 ASCII `\w`，即使 `u`） |
| `\b` CJK 词边界 | `\b猫\b` | `猫` | ✓ | ✗ | **不兼容**（同上） |
| `\b` ASCII | `\bcat\b` | `a cat` | ✓ | ✓ | 兼容 |
| `[\b]` 类内退格 | `[\b]` | U+0008 | ✓ | ✓ | 兼容（两引擎类内 `\b` 均指退格） |

### B. `.` 与换行

| 用例 | Pattern | 文本 | .NET | JS（非 u） | 判定 |
|---|---|---|---|---|---|
| `.` 匹配 `\r` | `.` | `\r` | ✓ | ✗ | **不兼容**（.NET `.` 匹配 `\r`；JS 把 `\r` 当行终止符） |
| `.` 匹配 `\n` | `.` | `\n` | ✗ | ✗ | 兼容（均不匹配） |
| `.` 匹配 U+2028 | `.` | U+2028 | ✓ | ✗ | **不兼容**（.NET 不把 U+2028 当行终止符，JS 视为行终止符） |
| `.` 匹配普通字符 | `.` | `a` | ✓ | ✓ | 兼容 |

> 对逐行 grep 的实际影响：.NET 行内永无 `\r`/`\n`，但 U+2028/U+2029 会留在行文本里，
> `.` 对该字符的差异在逐行场景下**仍会生效**，需 fixture 覆盖。

### C. 锚点

| 用例 | Pattern | 文本 | .NET | JS（非 u） | 判定 |
|---|---|---|---|---|---|
| `^abc$` 普通 | `^abc$` | `abc` | ✓ | ✓ | 兼容 |
| `^abc$` 尾随 `\n` | `^abc$` | `abc\n` | ✓ | ✗ | **不兼容**，但对逐行 grep **无效**（行内无 `\n`） |
| `\A` 字符串开头 | `\Aabc` | `abc` | ✓ | ✗（`\A`=字面 `A`，不报错） | **不兼容，静默** |
| `\z` 绝对结尾 | `abc\z` | `abc` | ✓ | ✗（`\z`=字面 `z`） | **不兼容，静默** |
| `\Z` 结尾或尾随 `\n` 前 | `abc\Z` | `abc\n` | ✓ | ✗（`\Z`=字面 `Z`） | **不兼容，静默**（逐行场景无效） |
| `\Z` 不匹配 | `abc\Z` | `abcX` | ✗ | ✗ | 兼容 |

> `\A`/`\z`/`\Z` 在 JS **不报错**而是按字面匹配（identity escape），属于最危险的「静默
> 语义漂移」类。逐行 grep 中 `\A`→`^`、`\z`→`$`、`\Z`→`$` 的改写是安全的（行内无换行）。

### D. 捕获组、命名组与反向引用

| 用例 | Pattern | 文本 | .NET | JS | 判定 |
|---|---|---|---|---|---|
| 普通捕获组/非捕获组/替换 | `alpha\|gamma`、`(?:a)` 等 | — | ✓ | ✓ | 兼容 |
| 命名组 `(?<name>…)` | `(?<name>abc)` | `abc` | ✓ | ✓ | 兼容 |
| 命名组 `(?'name'…)` | `(?'name'abc)` | `abc` | ✓ | `SyntaxError` | **不支持**（.NET 单引号语法） |
| 命名反向引用 `\k<name>` | `(?<x>a)\k<x>` | `aa` | ✓ | ✓ | 兼容 |
| 命名反向引用 `\k'name'` | `(?'x'a)\k'x'` | `aa` | ✓ | `SyntaxError` | **不支持** |
| 重名捕获组 | `(?<x>a)(?<x>b)` | `ab` | ✓ | `SyntaxError` | **不支持**（.NET 允许重名） |
| 重名 + 反向引用 | `(?<x>a)(?<x>b)\k<x>` | `abb` | ✓ | `SyntaxError` | **不支持** |
| 平衡组 `(?<a-b>…)` | `(?<open>x)(?<-open>)` | `x` | ✓ | `SyntaxError` | **不支持**（.NET 独有） |
| 平衡组嵌套 | `^(?<open>a)+(?<-open>b)+$` | `aabbb` | ✗ | `SyntaxError` | .NET 不匹配；JS 报错（结果类不同） |
| 条件组 `(?(…)…)` | `(?(?=a)a\|b)` | `a` | ✓ | `SyntaxError` | **不支持** |
| 条件组（组号） | `(a)?(?(1)b\|c)` | `ab` | ✓ | `SyntaxError` | **不支持** |
| 原子组 `(?>…)` | `(?>a\|ab)c` | `abc` | ✗（正确原子语义） | `SyntaxError` | **不支持**（Node 24.16 实测，见 §验证） |
| 原子组（另一分支） | `(?>ab\|a)c` | `abc` | ✓ | `SyntaxError` | **不支持** |

### E. 环视 lookaround

| 用例 | Pattern | 文本 | .NET | JS | 判定 |
|---|---|---|---|---|---|
| 前向断言 | `a(?=b)` | `ab` | ✓ | ✓ | 兼容 |
| 负前向断言 | `a(?!b)` | `ac` | ✓ | ✓ | 兼容 |
| 变长后行断言 | `(?<=a+)b` | `aaab` | ✓ | ✓ | **兼容**（Node 24 实测支持变长 lookbehind） |
| 有界后行断言 | `(?<=a{1,3})b` | `aaab` | ✓ | ✓ | 兼容 |
| 替换后行断言 | `(?<=a\|aa)b` | `ab` | ✓ | ✓ | **兼容**（Node 24 支持） |

> 变长 lookbehind 是本次探针的**反预期亮点**：历史认知「V8 只支持定长」已不适用于 Node 24；
> 但目标运行时是 Node `>=22.19`，该能力按小版本而异，需在固定运行时上复验（见 §待复核）。

### F. Unicode 属性与脚本

| 用例 | Pattern | 文本 | .NET | JS | 判定 |
|---|---|---|---|---|---|
| `\p{L}` 无 `u` | `\p{L}+` | `猫é` | ✓ | ✗（`\p`=字面 `p`，`{L}`=字面） | **不兼容，静默** |
| `\p{L}` 加 `u` | `\p{L}+` | `猫é` | ✓ | ✓ | 兼容（但依赖 `u` 标志） |
| `\P{L}` 无 `u` | `\P{L}` | `1` | ✓ | ✗ | **不兼容，静默** |
| `\p{IsGreek}` 脚本语法 | `\p{IsGreek}+` | `α` | ✓ | `SyntaxError`（`u` 下） | **不支持**（.NET 语法；JS 需 `\p{Script=Greek}`） |

### G. 特殊转义

| 用例 | Pattern | 文本 | .NET | JS | 判定 |
|---|---|---|---|---|---|
| 八进制 `\141`（非 u） | `\141` | `a` | ✓ | ✓ | 兼容 |
| 八进制 `\141`（加 u） | `\141` | `a` | ✓ | `SyntaxError` | **不支持**（`u` 标志禁止八进制） |
| `\R` 任意换行 | `a\Rb` | `a\nb` | 解析错误 | ✗（`\R`=字面 `R`，不报错） | **差异**（.NET 报错；JS 静默当字面量） |
| `Regex.Escape("a.b")` | `a\.b` | `a.b` | ✓ | ✓ | 兼容 |

### H. 大小写折叠（`IgnoreCase` / `i`）

| 用例 | Pattern/文本 | .NET（Invariant） | JS（`i`） | 判定 |
|---|---|---|---|---|
| ASCII | `abc` vs `ABC` | ✓ | ✓ | 兼容 |
| Unicode 字母 | `é` vs `É` | ✓ | ✓ | 兼容 |
| 开尔文符号 U+212A | `k` vs `K` | ✓ | ✗ | **不兼容**（.NET 简单折叠包含 K→k，JS 不折叠） |
| 长 s U+017F | `s` vs `ſ` | ✗ | ✗ | 兼容 |
| 土耳其点 i U+0130 | `i` vs `İ` | ✗ | ✗ | 兼容（文化无关，两引擎均不折叠） |

### I. 字面量模式与非法语法

| 用例 | Pattern | 文本 | .NET | JS | 判定 |
|---|---|---|---|---|---|
| literal 转义往返 | `a\.b` | `a.b` | ✓ | ✓ | 兼容（literal 路径只需自写等价的 `escapePattern`） |
| 非法正则 | `[unclosed` | `x` | `RegexParseException` → 工具 `error:` | `SyntaxError` → 需转 `error:` | **兼容判定**：两引擎都识别非法；仅错误文案不同（.NET「Unterminated [] set」vs JS「Unterminated character class」），均以 `error:` 前缀满足工具契约 |

### glob 派生正则（`Core/Tools/GlobMatcher.cs`）

生成的 `^(?:.*/)?[^/]*\.py$` 类表达式全部落在 JS 共同子集（非捕获组、转义点、字符类、
`^`/`$` 锚点），且匹配对象是 `/` 归一化、无尾随换行的相对路径，`$` 语义两引擎一致。
glob 过滤**不构成**兼容风险；`RegexOptions.Compiled` 仅是性能选项，无语义影响。

## 超时终止实验（worker_threads）

### 动机：两端引擎都无超时

GrepTool 构造 `new Regex(pattern, options)` **没有 TimeSpan**，.NET 引擎无超时。实测同一
灾难回溯模式 `(x+x+)+y` 在两端均呈指数爆炸：

| 输入长 n | .NET `IsMatch` 耗时 | JS `re.test` 耗时 |
|---|---|---|
| 20 | 11 ms | 73 ms |
| 24 | 19 ms | 1.41 s |
| 26 | 45 ms | 6.85 s |
| 28 | 123 ms | >10 s（`timeout 10` 击杀，exit=124） |
| 32 | 853 ms | — |
| 34 | 2.09 s | — |
| 36 | 6.16 s | — |
| 38 | >8 s（`timeout 8` 击杀，exit=124） | — |

即：C# 基线对单条恶意行（如 38 个 `x`）**同样会卡死 >8 秒且无自愈路径**。TS 迁移加
worker 超时终止是**新增安全边界**（`tools-and-platform.md` 已如此定位），不是降级。

### 实验 A：`worker.terminate()` 能杀死陷入正则的 worker

脚本 `$TMPDIR/p4-regex-probe/worker-terminate.mjs`：worker 内对 n=28 的
`"xxxx…!"` 跑 `/(x+x+)+y/`（已知 >10 s 不返回）；主线程 2 s 后调 `worker.terminate()`，
等待 `exit` 事件，并用 `setInterval(100ms)` 计数证明主线程未被阻塞。

```mjs
import { Worker } from "node:worker_threads";
const worker = new Worker(new URL("./worker-script.mjs", import.meta.url),
  { workerData: { n: 28, pattern: "(x+x+)+y" } });
worker.on("exit", (code) => { /* record code + elapsed */ });
setTimeout(async () => { await worker.terminate(); }, 2000);
await exitPromise;   // resolves only when the worker thread actually dies
```

实测输出（`node worker-terminate.mjs; echo $?`）：

```text
T+2015ms: calling worker.terminate()
T+2020ms: worker 'exit' event fired, code=1
ticks during worker hang: 18 (setInterval 100ms; >1 proves main thread unblocked)
EXPERIMENT_OK: caller unblocked after terminate
real  0m2.169s   user 0m0.000s   sys 0m0.046s
EXIT=0
```

证据结论：`terminate()` 在 **5 ms 内**强制结束陷入灾难回溯的 worker 线程并触发 `exit(code=1)`；
2 秒窗口内主线程 `setInterval` 正常跳了 18 次（即 worker 占用的是**独立线程**，主线程/事件循环
未阻塞）；调用方（主进程）随后正常退出，`EXIT=0`，无悬挂。**worker 终止被证实可用**。

### 实验 B（对照组）：`Promise.race` 单独无法兜底

脚本 `promise-race-control.mjs`：在同一主线程同步跑同一正则，并预置 500 ms「救援」
`setTimeout` + `Promise.race`：

```text
$ timeout 5 node promise-race-control.mjs > out.txt 2>&1
EXIT=124  wall_ms=6404
--- output ---
T+0: about to run catastrophic regex synchronously on the MAIN thread
T+0: rescue scheduled at 500ms, Promise.race set up
T+0: after setup — but main thread is now entering the regex, nothing else runs
（无 "rescue timeout FIRED"，无 RESOLVED）
```

证据结论：主线程进入正则后**事件循环整体冻结**——定时器、微任务、Promise.race 全部无法运行，
进程只能被外部 `timeout` 击杀（exit=124）。`Date.now()` 前后检查、`AbortSignal`、`Promise.race`
均不能中断同步正则。**必须**用独立线程承载正则，超时后 `terminate()`。

### 实验 C：替换 worker 的开销

`worker-churn.mjs`：50 次 spawn→exit 循环，实测平均 **38.2 ms/次**（本机 Node 24）。ReDoS
超时属于低频事件，terminate + 重建 worker 的开销（~40 ms）远低于被卡住的代价，可接受。

## 未支持语法清单（JS 编译报错、.NET 接受）

逐条为迁移 blocker（按 `tools-and-platform.md`：无等价语法必须显式处理，不得静默降级）。

1. **单引号命名组** `(?'name'…)` → `SyntaxError`；.NET 特有。
2. **单引号命名反向引用** `\k'name'` → `SyntaxError`；.NET 特有。
3. **重名捕获组** `(?<x>a)(?<x>b)` → `SyntaxError: Duplicate capture group name`；.NET 允许重名。
4. **平衡组** `(?<a-b>…)` / `(?<-a>…)` → `SyntaxError`；.NET 独有（常用在括号配对解析）。
5. **条件组** `(?(条件)是|否)` → `SyntaxError`；.NET 独有。
6. **原子组** `(?>…)` → `SyntaxError: Invalid group`（Node 24.16.0 非 `u` 与 `u` 下均实测
   报错）。注意：该特性已进入 ECMAScript 规范草案并可能在后续 V8/Node 版本落地，需在固定运行时复验。
7. **`\p{Is<Script>}` .NET 脚本语法**（如 `\p{IsGreek}`）→ `SyntaxError: Invalid property name`；
   JS 需改写为 `\p{Script=Greek}`（且依赖 `u` 标志）。
8. **`u` 标志下的八进制转义** `\141` → `SyntaxError`（`u` 标志禁止 legacy 八进制）。

## 行为差异清单（JS 能编译但结果不同）

按危险等级排列：

- **静默漂移类（最危险：不报错、结果错）**
  1. `\w`/`\d` 仅 ASCII：非 ASCII 字母/数字（如 `é猫`、`٣`）匹配结果不同——即使 `u` 标志也一样。
  2. `\b` 仅 ASCII 词边界：`\bé\b`、`\b猫\b` 在 JS 不匹配。
  3. `\A`/`\z`/`\Z` 被当作字面 `A`/`z`/`Z`（identity escape），不是报错。
  4. 非 `u` 下 `\p{L}`/`\P{L}` 被当作字面 `p{L}`/`P{L}`。
  5. `.` 不匹配 `\r` 与 U+2028/U+2029（JS 视其为行终止符）。
  6. `\R` 在 JS 是字面 `R`（.NET 是解析错误）——两边都「不匹配」但机制不同，错误可观测性不同。
  7. `i` 折叠：U+212A 开尔文符 `.NET` 折叠、JS 不折叠（简单折叠表有边界差异）。
- **错误处理差异**
  8. `$` 在尾随 `\n` 前的匹配：.NET `$` 匹配行尾换行前位置，JS 不匹配——对逐行 grep 无效，
     因为行内无换行；但整串匹配场景（若未来把整个文件喂给正则）会不同。
  9. 非法正则错误文案不同（均检测到非法，均以 `error:` 前缀返回，满足工具契约）。
- **相邻（非引擎）差异**
  10. 行切分：`File.ReadLines` 尾部换行不产生空行；`"a\n\nb\n".split(/\r\n|\r|\n/)` 会多出
      尾部空元素 → 模式 `^$`（空行）会对尾随换行报出**幽灵末行**。TS 切行须在尾部空元素上
      `pop`（且 `\r\n` 分支必须写在 `\r` 之前）。
  11. 逐行 grep 使 `^`/`$`/`\A`/`\z`/`\Z` 的换行差异全部失效（行内无换行），锚点改写
      `\A→^`、`\z→$`、`\Z→$` 在逐行场景下语义等价——这是最容易安全桥接的一组。

## 推荐结论

### 1. 承载与终止：worker_threads 方案可行（有实测证据）

- **必须**把每个有界 regex job 放进 `worker_threads` 的 worker，超时 `worker.terminate()`
  并重建 worker（替换）。实测证明：terminate 5 ms 内杀线程、触发 `exit(code=1)`、主线程全程
  未阻塞、调用方正常退出（EXIT=0）。重建开销 ~40 ms，可接受。
- `Promise.race` / `Date.now()` / `AbortSignal` 单独都**不能**中断同步正则（对照组实测：
  主线程冻结、救援定时器永不触发、进程被外部击杀 exit=124）。
- worker 承载范围建议：**整行批**而非单行——worker 内先 `new RegExp(pattern, flags)` 编译一次，
  再对该批行的 `re.test` 逐行执行并回传 `(lineNo, line)` 命中；超时则以该批为粒度 terminate 并
  标记「该文件部分结果」（复用现有 notices 风格，`tools-and-platform.md` 已规定部分结果必须明示）。
- 超时边界：在现有 60 s 扫描预算之外，新增**每个 regex job 的超时**（如 10 s），因为单行即可
  卡死 >60 s（实测 n=38 行 >8 s 且指数增长，500 字符上限行可到天文数字）。这是 TS 新增安全边界。

### 2. 语义兼容：worker 只解决「可终止」，不解决「结果等价」

worker 方案只解决 ReDoS 中断。`§未支持语法` 与 `§行为差异` 必须另行处理，推荐组合：

- **预检/显式错误**：所有模式先 `new RegExp(…)` 编译；`SyntaxError` → 工具 `error:`（与 .NET
  非法正则同一契约路径）。这样「.NET 能编译、JS 编译失败」的 8 类语法会**显式报错**而不是静默
  空结果，满足「不得静默降级」。错误文案可区分「非法」与「该 .NET 语法迁移不支持」，以便模型
  换模式。
- **可安全桥接的改写**（逐行 grep 前提下）：`\A→^`、`\z→$`、`\Z→$`；这组在逐行场景语义等价。
- **Unicode 简写类（`\w`/`\d`/`\s`/`\b`）与 `\p{...}`**：建议在 worker 侧用 `u` 标志 +
  小翻译层（如 `\w`→`[\p{L}\p{N}_]`、`\d`→`\p{Nd}`、`\b`→Unicode 词边界替代、`\p{IsX}`→
  `\p{Script=X}`），并把 `u` 引入的副作用（八进制被禁、`.` 变码点）按冻结 matrix 逐项确认。
  这是实现期的 conformance gate，本探针不越权定 flag 集；关键约束是：**不得**非 `u` 下让
  `\p{…}` 静默当字面量。
- **固定 Unicode fixture**：差异清单第 1、2、5、7 条必须落成跨平台 fixture（`é猫`、`٣`、
  `\r`/U+2028、`K`、`\b猫` 等），未通过项标「不兼容」而非「兼容」。

### 3. 备选方案评估

- **RE2 风格依赖**（`re2`/`node-re2`）：线性时间、天然防 ReDoS，但**不支持** lookaround、
  反向引用、条件/平衡/命名组变体——会把 `§对照表` D、E 段能力全部砍掉，且是 native binding，
  需按 `tools-and-platform.md` 的「平台能力与未决依赖门」先交一页决策记录（版本/许可/Node
  要求/Windows 构建/失败策略）。本探针不推荐作为首选；仅当 worker 方案被证明有不可克服的平台
  问题时再评估。
- **结论**：首选 **worker_threads + 显式预检 + 小翻译层 + 冻结 matrix**；worker 终止已被实证。

### 4. 待复核项

- 目标运行时 Node `>=22.19`：变长 lookbehind（Node 24 实测可用）与原子组（Node 24 实测
  **不可用**）随 V8 小版本而异，需在**固定的目标 Node 版本**上重跑本探针矩阵。
- 本探针在 Windows 11 / Node 24.16 / .NET 10 上完成；POSIX 平台需复验（worker 语义应一致，
  但应列入跨平台 gate）。
- `u` 标志集与翻译层的最终选择须由冻结 conformance matrix 裁决，本文件只提供证据。

## 关联

- 契约：[`tools-and-platform.md`](../tools-and-platform.md)「.NET 与 JavaScript 搜索语义差异」、
  「文件 IO 与 TUI 事件循环」（扫描预算/部分结果明示）、「最小实施顺序与停止条件」第 3 条。
- 基线源码：`Core/Tools/GrepTool.cs`、`Core/Tools/GlobMatcher.cs`；语料
  `Di.Tests/Tools/GrepToolTests.cs`（均对应 `09f4e08`）。
- 探针产物：`$TMPDIR/p4-regex-probe/`（`dotnet-results.txt`、`js-results.txt`、
  `worker-terminate.mjs`、`promise-race-control.mjs`、`js-hang.mjs`、`worker-churn.mjs`）。
