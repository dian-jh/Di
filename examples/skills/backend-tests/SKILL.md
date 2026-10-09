---
name: backend-tests
description: 运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。
metadata:
  author: di-team
  version: "0.1.0"
allowed-tools: bash read_file edit_file grep
---

# 后端测试工作流

1. 修改代码后先 `dotnet build`，再 `dotnet test`。
2. 若测试失败，用 grep 定位失败用例与测试文件，读相关源码弄清原因。
3. 修复后用 edit_file 精准修改，重跑受影响测试直到全绿。
4. 最后汇报：跑了哪些测试、通过多少、失败多少。
