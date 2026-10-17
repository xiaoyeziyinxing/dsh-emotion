# dsh-emotion

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 情绪模块插件：让 Agent 具备可感知、可表达、有记忆的情绪状态。

## 功能

- **感知**：每次用户消息经中文情感词典快评（正面/负面/反讽线索），强信号与反讽触发 LLM 复核纠偏
- **生成**：效价 valence × 唤醒 arousal 二维状态机，7 种规则标签（平静/开心/兴奋/低落/沮丧/烦躁/平静偏愉），LLM 可返回自由标签（如"讽刺"）
- **调节**：惰性时间衰减，每小时向中性回归
- **表达**：动态 system-prompt 段注入当前情绪（只描述不指令，≤60 字），模型回复自然带上情绪色彩
- **expressionStyle 三档**（v0.4.0）：`subtle`（默认，情绪显著时注入一行）/ `explicit`（始终注入完整状态行）/ `off`（不注入，纯内部记录仅供 UI 与 `get_mood`）
- **行动策略**：`get_mood` / `express_emotion` 两个 LLM 工具
- **情绪 chip（桌面端）**：对话框输入区左侧实时显示当前情绪（色点随效价变色），点击即开关情绪模块，状态持久化
- **安全对齐**：强负面情绪下，风险工具执行前经 `tools/pre-execute` 守卫追加确认（fail-closed，只加确认不跳过）
- **持久化**：`storageDomain`（version 1）落盘 `~/.dsh/storages/emotion.json`，跨进程/跨应用共享状态

## 安装

```bash
# npm（推荐）
dsh plugin add dsh-emotion

# 本地目录（开发迭代，改文件即生效）
dsh plugin add /path/to/dsh-emotion

# 或 tgz
npm run build && npm pack
dsh plugin add dsh-emotion-0.4.0.tgz
```

依赖 Node.js 18+；`dsh plugin` 内部依赖 pnpm。LLM 复核默认使用 profile 里的模型路由，可在 profile `cordis.patch.yml` 用 `dsh.bundle.patch` 覆写 `emotion-recheck` 的 provider/model。

## 配置

插件支持 Config schema（schemastery），在 profile `cordis.patch.yml` 的 bundle patch 里按 id 配置：

```yaml
- id: emotion
  name: dsh-emotion
  config:
    decayPerHour: 0.15        # 每小时向中性衰减（0~1）
    llmRecheckEvery: 6        # 每 N 轮最多 1 次 LLM 复核
    expressionStyle: subtle   # subtle | explicit | off
    llmProvider: minimax      # 复核用的 provider
    llmModel: MiniMax-M2      # 复核用的模型
```

## 开发

```bash
npm install
npm run build   # tsc：src/*.ts → lib/*.js（产物结构不变）
npm test        # vitest：37 用例，含 24 条中文样本回归基线（§12 C2）
```

源码在 `src/`（TypeScript），`lib/` 为构建产物。`lib/client.js` 保持无模块语法的脚本形态（宿主以经典 `<script>` 注入），请勿在其中使用 import/export。

## 验证

```bash
dsh headless "这系统又崩了，烦死了…垃圾体验"
# 日志应出现：[emotion] state -> 沮丧 v=... recheck=true
```

桌面客户端重启后，聊天输入框工具行左侧出现情绪 chip：色点颜色随效价变化（红=负面/绿=正面/灰=中性），点击可开关情绪模块（关闭后感知停摆、prompt 段置空、守卫放行）。

## 结构

```
src/index.ts    插件入口：感知钩子 + prompt 注入 + 守卫 + 工具 + /emotion/api 路由
src/client.ts   浏览器半包：EmotionChip（输入区 slot，轮询 /emotion/api）
src/logic.ts    纯函数情绪内核：词典/状态机/衰减/渲染/expressionStyle（可单测）
src/vendor.ts   defineDomain/defineTool 内联（npm dsh 包滞后，届时换回正式包）
tests/          vitest：logic / §12 24 样本回归 / 插件集成（fake 宿主 ctx）
lib/            构建产物（npm 包只发布 lib + cordis.patch.yml）
```

## 兼容性

- CLI 0.2.0-rc.2 实测通过（headless 与 web 应用端）；desktop 客户端 chip 实测通过
- 感知事件挂 `session/event` 的 `user/message`（`turn/end` 无对话文本）
- EmotionChip 走宿主 `webServer` prefix 路由 + client 半包 `__ModuleLoader__` 注册（实拆 dsh-better-sidebar@0.26.1 证实的外部插件 UI 通路），headless（无 webServer）自动跳过 UI 不影响本体
- `ctx.remote.$on` 仅转发宿主白名单事件，chip 采用 2s 轮询而非事件推送；`ctx.emit('emotion/changed')` 已预留
- v0.4.0 修正：跨重启恢复不再预衰减（读取时瞬态衰减，幂等，修复 v0.3.0 复合衰减）；`webServer.register` 以 bind 调用保留 this
