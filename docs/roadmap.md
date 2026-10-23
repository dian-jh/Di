# 路线图

当前项目以 TypeScript workspace 作为 CLI 和 agent harness 实现。核心功能入口见
[`docs/modules/README.md`](modules/README.md)，验证事实见
[`docs/typescript-validation.md`](typescript-validation.md)。

后续发布工作仍包括：在最终发布候选上完成各支持平台的长时间资源验证；定位此前 soak 中
超出冻结 RSS 阈值的增长；完成 macOS 自动系统代理解析及 PAC/WPAD 网络验收。任何单元测试或
短时间运行结果都不能代替这些门槛。
