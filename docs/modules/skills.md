# Skills

`packages/coding-agent/src/core/skills/skill-markdown.ts` 的 `parseSkillMarkdown` 解析 SKILL.md
frontmatter 与指令正文；识别字段重复或名称不符时拒绝该 skill。
`packages/coding-agent/src/core/skills/skill-repository.ts` 的
`loadSkills` 支持 `<name>/SKILL.md` 和 `<name>.md` 两种布局。来源依次为用户
`~/.agents/skills`、`DI_HOME/skills`、工作区祖先 `.agents/skills`（近处优先）和项目
`.di/skills`；后续来源覆盖先前同名 skill，无效文件以警告跳过。

`packages/coding-agent/src/core/skills/skill-matcher.ts` 的 `LexicalSkillMatcher` 做词法匹配；
`skill-activation.ts` 的 `computeSkillActivation` 合并固定启用项和自动匹配项。
`skill-context.ts` 构造广告上下文；`skill-tools.ts` 的 `LOAD_SKILL_TOOL` /
`createSkillAwareExecutor` 在模型请求完整 skill 时加载指令。带标签用例解析与指标评估分别在
`packages/coding-agent/src/core/skills/skill-case-loader.ts` 和
`packages/coding-agent/src/core/skills/skill-evaluator.ts`。
