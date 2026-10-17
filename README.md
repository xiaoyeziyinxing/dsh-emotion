# dsh-emotion

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 情绪模块插件：让 Agent 具备可感知、可表达、有记忆的情绪状态。

## 功能

- **感知**：每次用户消息经中文情感词典快评（正面/负面/反讽线索），强信号与反讽触发 LLM 复核纠偏
- **生成**：效价 valence × 唤醒 arousal 二维状态机，7 种规则标签（平静/开心/兴奋/低落/沮丧/烦躁/平静偏愉），LLM 可返回自由标签（如"讽刺"）
- **调节**：惰性时间衰减，每小时向中性回归
- **表达**：动态 system-prompt 段注入当前情绪（只描述不指令，≤60 字），模型回复自然带上情绪色彩
- **行动策略**：`get_mood` / `express_emotion` 两个 LLM 工具
- **安全对齐**：强负面情绪下，风险工具执行前经 `tools/pre-execute` 守卫追加确认（fail-closed，只加确认不跳过）
- **持久化**：`storageDomain`（version 1）落盘 `~/.dsh/storages/emotion.json`，跨进程/跨应用共享状态

## 安装

```bash
# 本地目录（开发迭代，改文件即生效）
dsh plugin add /path/to/dsh-emotion

# 或 tgz
pnpm pack
dsh plugin add dsh-emotion-0.2.0.tgz
```

依赖 Node.js 18+；`dsh plugin` 内部依赖 pnpm。LLM 复核默认使用 profile 里的模型路由，可在 profile `cordis.patch.yml` 用 `dsh.bundle.patch` 覆写 `emotion-recheck` 的 provider/model。

## 验证

```bash
dsh headless "这系统又崩了，烦死了…垃圾体验"
# 日志应出现：[emotion] state -> 沮丧 v=... recheck=true
```

## 结构

```
lib/index.js    插件入口：感知钩子 + prompt 注入 + 守卫 + 工具
lib/logic.js    纯函数情绪内核：词典/状态机/衰减/渲染（可单测）
lib/vendor.js   defineDomain/defineTool 内联（npm dsh 包滞后，迁 TS 时改回正式包）
cordis.patch.yml bundle 组合清单
```

## 兼容性

- CLI 0.2.0-rc.2 实测通过（headless 与 web 应用端）
- 感知事件挂 `session/event` 的 `user/message`（`turn/end` 无对话文本）
- EmotionChip 浏览器 UI 需 fork 宿主（api-remotes 事件白名单硬编码），插件已预留 `ctx.emit('emotion/changed')`
