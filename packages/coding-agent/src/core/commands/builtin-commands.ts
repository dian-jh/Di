import type { CommandContext } from "./command-context.ts";
import type { CommandResult, SlashCommand } from "./slash-command.ts";
import { HANDLED, QUIT, turnCommand } from "./slash-command.ts";
import { SlashCommandRegistry } from "./slash-command-registry.ts";
import { ModelSelectionError } from "../model-selection.ts";

/*
 * Builtin slash commands (mode-agnostic: they reach capabilities ONLY through
 * {@link CommandContext}; REPL and RPC share the same set).
 */
export function createBuiltinRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  registry.registerAll(createBuiltinCommands());
  return registry;
}

export function createBuiltinCommands(): readonly SlashCommand[] {
  return [
    { name: "exit", description: "退出 Di", handler: () => QUIT },

    { name: "help", description: "显示命令帮助", handler: (_args, ctx) => {
      ctx.output.writeLine(ctx.registry.buildHelp());
      return HANDLED;
    } },

    { name: "clear", description: "清空屏幕与对话记忆", handler: (_args, ctx) => {
      if (ctx.useAnsi ?? true) ctx.output.write("\x1b[2J\x1b[H"); // ANSI clear (main screen); omitted under redirect / RPC
      ctx.host.resetHistory();
      ctx.output.writeLine("已清空屏幕与对话记忆");
      return HANDLED;
    } },

    { name: "model", description: "查看或切换模型", argumentHint: "[provider/model | 名称 | --refresh]", handler: async (args, ctx) => {
      if (ctx.models === undefined) {
        ctx.output.writeLine("宿主未提供模型选择器。");
        return HANDLED;
      }
      try {
        if (args === "" || args === "--refresh") {
          if (args === "--refresh") {
            for (const error of await ctx.models.refresh(ctx.signal)) ctx.output.writeLine(error);
          }
          ctx.output.writeLine(`当前模型: ${ctx.models.current.qualifiedId}`);
          for (const model of ctx.models.list()) ctx.output.writeLine(`  ${model.provider}/${model.id}  ${model.name}`);
          ctx.output.writeLine("用法: /model <provider/model 或唯一名称>；/model --refresh 刷新目录。");
        } else {
          await ctx.models.select(args, ctx.signal);
          ctx.output.writeLine(`模型已切换为 ${ctx.host.currentModel}`);
        }
      } catch (error) {
        if (error instanceof ModelSelectionError) ctx.output.writeLine(error.message);
        else throw error;
      }
      return HANDLED;
    } },

    { name: "thinking", description: "查看或切换推理强度", argumentHint: "[强度 | default]", handler: async (args, ctx) => {
      if (ctx.models === undefined) {
        ctx.output.writeLine("宿主未提供模型选择器。");
        return HANDLED;
      }
      try {
        if (args.length > 0) await ctx.models.setReasoning(args, ctx.signal);
        const model = await ctx.models.resolveCurrent(ctx.signal);
        const effort =
          ctx.models.reasoningEffort ??
          (model.reasoning?.defaultEffort !== undefined ? `default (${model.reasoning.defaultEffort})` : "default");
        ctx.output.writeLine(`推理强度: ${effort}`);
        ctx.output.writeLine(
          model.reasoning !== undefined
            ? "支持档位: " + model.reasoning.efforts.map((e) => e.id).join(", ")
            : "目录未提供模型专属档位，实际支持情况由模型校验。",
        );
      } catch (error) {
        if (error instanceof ModelSelectionError) ctx.output.writeLine(error.message);
        else throw error;
      }
      return HANDLED;
    } },

    { name: "usage", description: "查看 ChatGPT 订阅额度入口", handler: (_args, ctx) => {
      ctx.output.writeLine("ChatGPT 官方额度: https://chatgpt.com/settings/usage");
      ctx.output.writeLine("此官方 OAuth 接口未公开五小时/每周剩余额度查询，无法在本地准确显示；请以账户 Usage 页面为准。");
      ctx.output.writeLine("本地 tokens/cache_read/cache_write 是请求计量，不代表订阅剩余额度。");
      return HANDLED;
    } },

    { name: "skills", description: "列出可用 skill（固定激活的以 * 标记）", handler: (_args, ctx) => {
      listSkills(ctx);
      return HANDLED;
    } },

    { name: "skill", description: "激活/停用 skill；带参数一次性执行", argumentHint: "<名称> [参数]", handler: (args, ctx) => handleSkill(args, ctx) },
  ];
}

function listSkills(ctx: CommandContext): void {
  if (ctx.skills.length === 0) {
    ctx.output.writeLine("没有可用 skill。把 <名称>/SKILL.md 或 <名称>.md 放在 ~/.di/skills/ 或 <工作区>/.di/skills/ 下。");
    return;
  }
  for (const skill of ctx.skills) {
    const marker = ctx.pinned.includes(skill) ? "*" : " ";
    ctx.output.writeLine(`  [${marker}] ${skill.name} —— ${skill.description}`);
  }
}

/**
 * /skill: no args shows usage; `<name>` toggles pinned activation; `<name> <args>`
 * one-shot execution — full instructions + args request the host to run one turn
 * (Pi's /skill:name args), not pinned.
 */
function handleSkill(args: string, ctx: CommandContext): CommandResult {
  const { name, args: skillArgs } = SlashCommandRegistry.split(args);
  if (skillArgs.length > 0) {
    const skill = ctx.skills.find((s) => s.name === name);
    if (skill === undefined) {
      ctx.output.writeLine(`未找到 skill：${name}（/skills 查看可用列表）`);
      return HANDLED;
    }
    const message = `【Skill：${skill.name}】${skill.description}\n\n${skill.instructions}\n\n${skillArgs}`;
    return turnCommand(message);
  }
  return toggleSkill(name, ctx);
}

/** /skill: with a name toggles pinned activation; off/none clears the pinned set; no args shows current + usage. */
function toggleSkill(name: string, ctx: CommandContext): CommandResult {
  if (name.length === 0) {
    ctx.output.writeLine(
      ctx.pinned.length === 0
        ? "当前未固定任何 skill。用法: /skill <名称> 固定（再输一次停用，/skill off 全部停用）；/skill <名称> <参数> 一次性执行（指令+参数）。匹配到的 skill 也会自动加载。"
        : `当前已固定：${ctx.pinned.map((s) => s.name).join("、")}。用法: /skill <名称> 切换；/skill <名称> <参数> 一次性执行。`,
    );
    return HANDLED;
  }
  if (name === "off" || name === "none") {
    ctx.pinned.length = 0;
    ctx.host.setActiveSkills([...ctx.pinned]);
    ctx.output.writeLine("已停用全部 skill");
    return HANDLED;
  }
  const skill = ctx.skills.find((s) => s.name === name);
  if (skill === undefined) {
    ctx.output.writeLine(`未找到 skill：${name}（/skills 查看可用列表）`);
    return HANDLED;
  }
  if (ctx.pinned.includes(skill)) {
    ctx.pinned.splice(ctx.pinned.indexOf(skill), 1);
    ctx.output.writeLine(`已停用 skill：${skill.name}`);
  } else {
    ctx.pinned.push(skill);
    ctx.output.writeLine(`已激活 skill：${skill.name}`);
  }
  ctx.host.setActiveSkills([...ctx.pinned]);
  return HANDLED;
}
