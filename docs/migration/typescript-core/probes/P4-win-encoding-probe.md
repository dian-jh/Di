# P4-win-encoding-probe：Windows shell 输出编码预研

> 状态：预研结论（PRE-RESEARCH）。任务 ID `P4-win-encoding-probe`，对应
> [operator-guide.md](../operator-guide.md) 预研表与本仓库 Windows 编码契约
> [tools-and-platform.md §Windows OEM/GBK 与 UTF-8 输出](../tools-and-platform.md)。
> 固定 C# 基线 `09f4e08`；旧源码一律经 `git show 09f4e08:<path>` 读取。
> 本页只记录证据与选型，不接入主流程、不提交任何代码。
>
> 测试机：Windows 11 Enterprise 10.0.26100（win32），Node `v24.16.0`（full-icu
> `78.3`，Unicode 17.0）。探测脚本在仓库外临时目录运行（`$TMPDIR/p4-win-encoding-probe`），
> 未进入 git 工作区。

## 结论速览

- **本机真实 OEM 代码页 = 936（GBK，简体中文）**：`chcp`、注册表 `OEMCP`、.NET
  `TextInfo.OEMCodePage`、ACP 全部一致；系统语言 `0804`（zh-CN）。所有发现机制都返回 936。
- **取码页必须小 spawn，Node 内置无法取得**：`node:os` 不暴露任何 locale/code page 能力
  （`os.locale` 在 Node 24 不存在，`os` 无相关键）。最小可行方案是启动时跑一次 `chcp.com`
  （本机约 53ms）并解析尾部 ASCII 数字；`reg.exe` 查询同量级（约 49ms）可作交叉验证；
  PowerShell 权威（就是 C# 用的值）但启动约 1.2s。
- **Node ICU `TextDecoder` 支持 GBK（`gbk`/`gb2312` 标签）但不支持 CP437**：`new TextDecoder('ibm437')`
  直接抛 `ERR_ENCODING_NOT_SUPPORTED`。这正好覆盖契约要求的「至少一个非 GBK OEM 的能力探测/失败路径」——
  437 就是那个必须走失败路径的样例。补位解码器选 **`iconv-lite@0.7.3`（MIT）**，它同时覆盖
  gbk/437/932/950/ibm866 等 TextDecoder 覆盖不到的标签。
- **分片多字节解码**：逐字节读取时 `TextDecoder` 的 `decode(chunk)`（默认 `stream:false`）
  会按「每段独立终结」解码，对 GBK/UTF-8 全部输出 U+FFFD——**必须传 `{stream:true}`**（末次
  `decode()` 不传以 flush）；或按 C# 方案「收原始字节、段末一次性解码」。两者在 1 字节分片下
  都正确重装（无替换符）。`StringDecoder('utf8')` 只对 UTF-8 有效，GBK 直接乱码。
- **混合编码**：同一条 pipe 里 GBK 行与 UTF-8 行并存时，整段一次解码（C# 现状）无法两全——
  严格 UTF-8 失败后整段落 OEM，UTF-8 行被解成乱码；逐行 SmartDecode 可两全（GBK 行落 GBK、
  UTF-8 行落 UTF-8，均无替换符）。逐行方案是相对 C# 的**行为改进**，首期先按契约做整段兼容，
  把逐行作为候选改进记录。
- **截断**：Node 复刻 C# `BoundedByteBuffer`（头 6000 / 尾 18000 原始字节）后，UTF-8 中文字符被
  头/尾接缝切断时，SmartDecode 的 1–3 字节接缝裁剪保证头/尾段不整段误判、不出现替换符，代价是
  接缝处至多损失一个字符；内存恒定有界。
- **错误路径**：严格 UTF-8 用 `new TextDecoder('utf-8', {fatal:true})`，非法字节抛
  `TypeError: ERR_ENCODING_INVALID_ENCODED_DATA`（对应 C# 的 `DecoderFallbackException`），是「判
  UTF-8 失败 → 回退 OEM」的判定信号；OEM 解码器不存在时按契约返回显式解码错误并保留有界 raw bytes。

## 1. 真实 OEM 代码页获取机制

### 候选机制与本机证据

| 机制 | 本机结果 | 耗时（5 次均值） | 可靠性 |
|---|---|---|---|
| `chcp.com`（无参） | 尾部数字 `936` | 约 53ms | 稳定，exit 0 |
| `cmd.exe /c chcp` | `936` | 约 97ms | 稳定 |
| PowerShell `[CultureInfo]::CurrentCulture.TextInfo.OEMCodePage` | `936` | 约 1178ms | 稳定，**与 C# 同源**（见下文） |
| PowerShell `[Console]::OutputEncoding.CodePage` | `936` | 约 1239ms | 稳定，但语义是控制台输出编码非 OEM |
| `reg.exe query HKLM\...\Nls\CodePage /v OEMCP` | `OEMCP REG_SZ 936` | 约 49ms | 稳定，输出 ASCII |
| `Get-CimInstance Win32_OperatingSystem).OEMCP` | **空输出** | — | 本机 spawn 上下文不可用（3/3 为空），不推荐 |
| `node:os` | 无任何 locale/code page 键；`os.locale` 不存在 | 0 | 不可用 |

补充：ACP（ANSI）同为 `936`，`InstallLanguage=0804`。OEM 与 ANSI 在本机重合是中文系统的常态
（都映射 936/GBK）；但契约明确「不可把 GBK 写死为所有 Windows 的默认」，西文系统 OEM=437。

### 机制选择

- **主选：启动时 spawn 一次 `chcp.com`，正则取尾部十进制数字**。输出本身是 OEM 字节
  （本机是 GBK 的「活动代码页: 936」），但数字是 ASCII，`/(\d+)$/` 即可无歧义解析；约 50ms、
  无 PowerShell 启动成本。对应 C# 取码页所需的「Windows API 小适配层」之前的最小可行实现，
  与 [tools-and-platform.md §最小实施顺序 5](../tools-and-platform.md) 的「OEM code page
  discovery adapter」对齐。
- **交叉验证：`reg.exe` 读 `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage\OEMCP`**（REG_SZ）。
  注意 Node 侧必须用参数数组传路径，反斜杠不可被 shell 吃掉（实测 heredoc 会吞 `\`，改用 Write
  建脚本后正常）。
- **权威参考：PowerShell `TextInfo.OEMCodePage`** —— 与 C# `ProcessEncoding` 静态构造用的
  `CultureInfo.CurrentCulture.TextInfo.OEMCodePage` 同源，可作为单元测试的期望值来源，但不在
  生产路径选它（1.2s 太慢）。
- 不做原生 binding（`GetOEMCP`）作为首期方案：MVP 优先、避免 node-gyp 构建/分发链；若后续要求
  「每台机器一次原生调用」再按
  [operator-guide.md §必须停止当前单元并记录的情况](../operator-guide.md) 评估原生适配层。
- 缓存：OEM 页在进程生命周期内不变，发现后缓存；首次 shell 命令前惰性触发即可。

## 2. 解码器支持性探测

### Node ICU `TextDecoder` 标签支持（本机实测）

| 标签 | 结果 | 解析目标 |
|---|---|---|
| `gbk` / `gb2312` / `csgb2312` | OK | `gbk`（=936） |
| `gb18030` | OK | `gb18030` |
| `ibm866` / `cp866` / `866` | OK | `ibm866`（俄文 OEM 常用） |
| `big5` | OK | `big5` |
| `shift_jis` | OK | `shift_jis`（≈932） |
| `windows-1252` / `windows-1251` / `koi8-r` / `iso-8859-1` | OK | 各自 |
| **`ibm437` / `cp437` / `437` / `x-ibm437`** | **FAIL** `ERR_ENCODING_NOT_SUPPORTED` | 无 |
| `cp936` / `cp932` / `cp950`（数字/`cp` 前缀别名） | FAIL `ERR_ENCODING_NOT_SUPPORTED` | 无 |

要点：

- WHATWG 标签集不含 CP437（西文 Windows 的 OEM 页），也不认 `cpNNN` 写法。因此
  「OEM=437」的机器必须走补位解码器，这正是契约要的失败路径样例。
- 探测方法：`new TextDecoder(label)` 构造即抛/成功（无需解码样例），把 OEM CP 号先映射到
  标签（936→`gbk`，65001→`utf-8`，866→`ibm866`，…），映射不到或构造失败即判不支持。
- `Buffer.isEncoding('gbk') === false`：`spawn({encoding:'gbk'})` / `Buffer.toString('gbk')`
  一律不可用，必须收集原始字节后用 `TextDecoder`/`iconv-lite` 解码。

### 补位解码器：`iconv-lite@0.7.3`（已实测安装）

- 版本：`0.7.3`（2026 实测 npm 最新），许可证 **MIT**，`engines: node >=0.10.0`，
  唯一运行时依赖 `safer-buffer >=2.1.2 <3.0.0`（MIT），纯 JS 无原生编译。
- 支持面：`encodingExists('437')`/`'gbk'`/`'936'`/`'cp932'`/`'cp950'`/`'ibm866'`/`'windows-1252'`
  全为 `true`，且认数字别名（`'936'`）。
- 流式 API：`iconv-lite.getDecoder(enc)` 返回带 `write(buf)`/`end()` 的增量解码器，前导字节跨
  `write()` 调用间正确缓冲（实测 GBK `0xC4`→`''`，续字节 `0xE3`→`'你'`）；也可不流式——按
  C# 方案收集整段后 `decode(buf)` 一次解。
- 依赖决策记录（对应 operator-guide 新增依赖条目）：固定 `iconv-lite@0.7.3`，MIT，Node>=0.10
  兼容 `>=22.19`，Windows/Linux 行为一致（纯 JS），失败路径 = 若安装缺失则 `require` 失败，
  此时对 437 等不支持页返回显式解码错误 + 保留有界 raw bytes，不静默乱码。
- 备选不引入：`TextDecoder` 对 936/utf-8/866/1252/big5/shift_jis 已够用，只对 437/932/950 等
  少量页需要 iconv-lite；不引入 whole runtime。

## 3. 分片多字节解码（1 字节读取）

### 方法

子进程：`cmd.exe /c echo 你好世界`（GBK 字节生产者）与 `node -e "process.stdout.write('你好世界')"`
（UTF-8 生产者）各一个；父进程把 stdout 按 1 字节/块读入，喂给候选解码器。

### 结果

| 解码器 | GBK 流（`c4e3bac3cac0bde7…`） | UTF-8 流（`e4bda0…`） |
|---|---|---|
| `TextDecoder('gbk')` + `{stream:true}` 1B | ✓ `你好世界\r\n`，无替换符 | ✗ 乱码 `浣犲ソ涓栫晫` |
| `TextDecoder('utf-8')` + `{stream:true}` 1B | ✗ 全替换符 | ✓ `你好世界` |
| `StringDecoder('utf8')` 1B | ✗ 全替换符 | ✓ `你好世界` |
| 收集整段 + 严格 UTF-8（fatal） | ✗ 抛 `ERR_ENCODING_INVALID_ENCODED_DATA` | ✓ |
| 收集整段 + GBK | ✓ | ✗ 乱码 |
| 收集整段 + SmartDecode（C# 复刻） | ✓ | ✓ |

关键陷阱：**`TextDecoder('gbk').decode(chunk)` 不带 `{stream:true}` 时，每个 chunk 都被当段末
终结**，1 字节分片下 GBK/UTF-8 都输出 U+FFFD——这是最容易写错的地方。非末次调用必须
`decode(chunk, {stream:true})`，末次 `decode()` flush。整段收集（C# 方案）天然规避该问题，
推荐作为主路径。

## 4. 混合编码（一条流里 GBK + UTF-8）

### 方法

受控子进程把三行写进同一条 stdout：GBK 行（iconv-lite 编码，模拟 cmd 内建）、UTF-8 行（模拟
.NET CLI/Node）、GBK 行（交错生产者）。

### 结果

| 解码器 | 三行解码 |
|---|---|
| `TextDecoder('gbk')` 流式 | GBK 行 ✓，UTF-8 行乱码（含替换符） |
| `TextDecoder('utf-8')` 流式 | UTF-8 行 ✓，GBK 行全替换符 |
| 整段 SmartDecode（C# 现状） | GBK 行 ✓，UTF-8 行乱码（严格 UTF-8 因 GBK 字节失败 → 整段落 OEM） |
| **逐行 SmartDecode**（按 `\n` 分行、每行严格 UTF-8 失败才落 OEM） | **三行全对** `你好世界(GBK行)\n你好世界(UTF8行)\n再见(GBK行)\n`，无替换符 |

说明：

- 整段一次解码的行为与 C# `ProcessEncoding.SmartDecode` 一致（单生产者假设）；混合生产者
  并存时 C# 依赖「每条命令独立成段」隔离，段内混源仍是短板。
- 逐行方案字节安全：`0x0A` 不是 UTF-8（续字节 `0x80–0xBF`）也不是 GBK（续字节 `0x40–0x7E`、
  `0x80–0xFE`）的续字节，多字节字符不可能跨 `\n`。单行内仍混源时逐行同样救不了（与 C# 同理）。
- 首期按契约实现整段 SmartDecode 以保持 C# 兼容；把「逐行 SmartDecode」记录为候选改进，
  需要时作为独立可见行为变更引入（改回填文本形态，需重新验收）。

## 5. 截断与有界内存

### 方法

Node 复刻 C# `BoundedByteBuffer`（头 6000 / 尾 18000 原始字节、超限丢弃中间、`ToText` 时头尾
分别解码并插 `…[输出过长，已截断中间 N 字节]…`）。两个子进程：UTF-8 流 `'A'×5998 + '好'×7000`
（接缝正好切断 3 字节中文字符），GBK 流 `'好'×13500`。

### 结果

| 场景 | 结果 |
|---|---|
| UTF-8 流，头/尾接缝切中文字符 | 无替换符；头段 5998 个 A 完整保留（接缝 2 字节残片被 SmartDecode 裁剪）；尾段以完整 `好` 开头；`好` 内容保留 |
| GBK 流 | 6000 字节整倍，接缝不切片；无替换符；若接缝落在 GBK 字符中间（如 5999+1 前导字节），OEM 解码会与后续字节重新成对（移位而非替换符），与 .NET `GetEncoding(936)` 行为一致 |
| 未超预算 | 头+尾拼成整段一次解码，接缝无关，`A…好世界` 正确 |
| 内存 | 恒保留 ≤ 头 6000 + 尾 18000 字节，`(head+tail)/total` 有界；任意长输出不放大内存 |

契约点全部满足：字节级有界收集、头尾解码、接缝 1–3 字节裁剪、中间截断提示。实现应照抄
`BoundedByteBuffer` 的字节预算（6000/18000）与提示文案。

## 6. 错误路径

- 严格 UTF-8 判定：`new TextDecoder('utf-8', {fatal:true})` 对非法字节抛
  `TypeError`（`code: ERR_ENCODING_INVALID_ENCODED_DATA`）——对应 C# `StrictUtf8` +
  `DecoderFallbackException`，即「判失败 → 回退 OEM」的判定信号。
- 非 fatal 解码器对非法字节输出 U+FFFD：GBK `0x81`/`0xFF` → `�`；`0x81 0x20` → `� `。
  只有当接缝位置才允许至多一个替换符，不得静默全段替换。
- OEM 解码器缺失（如 OEM=437 且无 iconv-lite）：按契约返回**显式解码错误**并保留有界 raw
  bytes 供诊断，不谎称兼容、不输出整段乱码。
- 实测子进程管道非 TTY（`isatty(0/1/2)=false`），与生产 spawn 一致，无需特判 TTY。

## 7. 推荐 Node 实现路径

1. **取码页**：启动/首次命令前惰性 `spawn('chcp.com')`，`/(\d+)\s*$/` 取数字；`reg.exe`
   `OEMCP` 作交叉验证；缓存。实测本机 = **936（GBK）**。
2. **能力探测**：OEM CP → 标签映射（936→`gbk`，65001→`utf-8`，866→`ibm866`，1252→
   `windows-1252`，…）；`new TextDecoder(label)` try/catch；失败且页属 iconv-lite 覆盖范围时
   用 `iconv-lite`；两者皆无则记「该页不可解码」，返回显式错误路径。
3. **解码**：按字节收集（**禁止 `spawn({encoding:'utf8'})` 直接流式解**），段末 SmartDecode 复刻
   `ProcessEncoding.SmartDecode`：严格 UTF-8（fatal）→ 裁尾 1–3 字节重试 → 裁头 1–3 字节重试 →
   OEM 解码器。Python/git 显式约定 UTF-8 的命令仍走 `outputEncoding:'utf-8'` 钉死（对应
   `PythonTool` 的 `PYTHONIOENCODING=utf-8` + 显式 UTF-8）。
4. **有界**：头 6000/尾 18000 字节缓冲 + 中间截断提示，接缝裁剪；持久 shell 会话按命令分段、
   字节级剥 echo 行后逐段 SmartDecode（对应 `ShellSession`）。
5. **依赖**：`iconv-lite@0.7.3`（MIT，Node>=0.10，纯 JS，仅 `safer-buffer`）只用于 TextDecoder
   覆盖不到的页；固定版本入 lockfile。native `GetOEMCP` 适配层留作后续评估，非首期。

## 8. 复现脚本

探测脚本在仓库外 `$TMPDIR/p4-win-encoding-probe/`（本机 `C:\tmp4\p4-win-encoding-probe\`），
未入库：

- `probe1-codepage.mjs` / `probe1b-codepage.mjs` / `probe1c-registry.mjs`：码页发现机制对比
- `probe2-textdecoder.mjs`：TextDecoder 标签支持面
- `probe3-fragment.mjs`：1 字节分片多字节解码
- `probe4b-mixed.mjs`：混合 GBK+UTF-8 单流
- `probe5-truncation.mjs` / `probe5b-gbkseam.mjs`：截断/接缝/错误路径
- `probe6-discovery-cost.mjs`：发现机制耗时
- `probe7-chcp65001.mjs` / `probe7b-check.mjs`：`chcp` 对管道字节的影响

脚本名是未来实施者的复现入口；如正式测试需要，应迁移进 `packages/coding-agent/` 的 node:test
红测（见 [tools-and-platform.md §红测试清单 5](../tools-and-platform.md)）。

## 9. 与固定基线的关系

C# 行为依据（`git show 09f4e08:`）：

- `Core/Tools/ProcessEncoding.cs`：`ChildOutput = Encoding.GetEncoding(OEMCodePage)`、
  `StrictUtf8`（throwOnInvalidBytes）、`SmartDecode`（严格 UTF-8 → 裁 1–3 字节 → OEM 回退）。
- `Core/Tools/ProcessRunner.cs`：`BoundedByteBuffer` 原始字节收集、段末 `Decode`；超时/取消后
  保留有界 partial。
- `Core/Tools/BoundedByteBuffer.cs`：头 6000 / 尾 18000 字节、`…[输出过长，已截断中间 N 字节]…`。
- `Core/Tools/ShellSession.cs`：cmd stdin 钉 OEM、PowerShell stdin 无 BOM UTF-8、按命令分段
  原始字节收集、字节级剥 echo 行、`SmartDecode`。
- `Core/Tools/PythonTool.cs`：`PYTHONIOENCODING=utf-8` + 显式 UTF-8 解码。
- `Di.Tests/Tools/EncodingTests.cs`：`SmartDecode_*` 单元用例、`ProcessRunner_OemProducer_IsDecoded`、
  `Bash_Session_MixedGbkAndUtf8_Producers_AreBothDecoded`（跨命令分段两全）、
  `BoundedByteBufferTests.Append_SplitUtf8Char_AcrossHeadTailSeam_DoesNotGarbleWholeHead`。

本预研实测与基线文档一致处：`chcp 65001` 不改变重定向管道字节（`chcp 65001` 后 cmd `echo` 输出
GBK 或 `?`，均非 UTF-8）；同一管道字节源可随控制台历史漂移——`chcp 65001` → `chcp 936` 回环后
cmd 内建 `echo` 会把中文写成 UTF-8 字节。这进一步印证「UTF-8 优先、OEM 兜底」的段级智能解码
不可省略。
