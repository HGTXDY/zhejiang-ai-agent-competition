# Prompt 策略（菜谱结构化解析与通知）

> 赛题交付物要求「技术方案文档（含调度算法设计、Prompt 策略、通知生成机制等）」。
> 本文档是 Prompt 策略的单一事实来源，对应实现见 `backend/app/parser/prompts.py`
> 与 `backend/app/parser/llm.py`。

## 1. 总体策略：结构化抽取 + 规则兜底（Hybrid）

系统把「理解」与「规划」严格分层。大模型只负责**自然语言 → 结构化任务**这一跳，规划层
（OR-Tools CP-SAT）只消费经过校验的结构化 JSON，大模型输出永远不直接成为最终排程。

因此 Prompt 策略的核心不是「让模型说得更漂亮」，而是：

1. **约束输出形状**：要求只输出 JSON 数组，字段、枚举、单位全部写死在系统提示中；
2. **把不确定性显式化**：缺失字段必须返回 `null`，由规则层标记 `field_status`
   （`provided / inferred / defaulted / missing`）而不是让模型编造；
3. **规则兜底**：模型漏给、给错的字段，由确定性解析器（`DeterministicParserAdapter`）
   回填，保证输出**永远**通过 `task.schema.json` 校验。

```text
菜谱原文 ──▶ SYSTEM_PROMPT + 步骤列表 ──▶ LLM ──▶ JSON 数组
                                                  │
                                   (extract_json_array 提取/容错)
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                          │  逐字段覆盖：仅接受「合法」的模型字段            │
                          ▼                                                ▼
              确定性解析器基线（一定合法）        模型字段合法才覆盖，否则保留基线
                          └───────────────────────┬───────────────────────┘
                                                  ▼
                                    RecipeParser 统一 Schema 校验
```

## 2. 系统提示（System Prompt）设计要点

`SYSTEM_PROMPT`（`prompts.py`）承载角色、字段契约与硬约束，可随版本演进：

- **角色**：方太智能厨房的菜谱结构化解析器；
- **输出格式**：只输出 JSON 数组，禁止 Markdown 代码块、禁止解释；
- **字段契约**：逐字段说明 `device_type / mode / temperature_c / duration_sec /
  manual_required / manual_segments / predecessors / confidence`；
- **七类设备枚举**：`range_hood / stove / steamer / oven / refrigerator / dishwasher /
  water_purifier`，并给出常见误判修正（「锅/炒锅/炖锅」→ `stove`；「冷藏/冷冻/解冻」→
  `refrigerator`；蒸烤一体机须按模式信号判定蒸或烤）；
- **单位与时间**：温度统一摄氏度，时长统一秒（小时 ×3600、分钟 ×60），文本没有就填 `null`；
- **人工介入**：切/洗/拌/翻炒/放入/取出等动作须 `manual_required = true`。

## 3. 用户提示（User Prompt）

`build_user_prompt` 只发送「菜名 + 菜谱 ID + 按序编号的步骤」，**不发送食材清单**——排程由
步骤驱动，食材列表与调度无关，发送反而增加幻觉面。步骤用 `[0] [1] [2] …` 编号，让模型能
直接引用下标表达 `predecessors`。

## 4. 解析后处理与容错

`extract_json_array` 容忍模型把 JSON 包进 ```` ```json ```` 代码块或包裹在 `{"tasks": ...}`
对象中。`_index_llm_items` 用 `source_step_index`（或列表位置）把模型输出对齐到步骤，保证
即使模型漏掉某一步也能回填。

`LLMParserAdapter._merge` 的覆盖规则是**逐字段、只接受合法值**：

| 字段 | 接受条件 | 非法时的行为 |
|---|---|---|
| `device_type` | 属于七类枚举 | 保留规则基线 |
| `mode` | 非空字符串 | 保留规则基线 |
| `temperature_c` | 整数且 ∈ [-50, 500] | 保留规则基线 |
| `duration_sec` | 正整数（兼容 `duration_minutes` ×60） | 保留规则基线 |
| `manual_required` | 布尔 | 保留规则基线 |
| `manual_duration_sec` / `manual_segments` | 合法且不超出任务时长 | 保留规则基线 |
| `predecessors` | 引用真实且更早的步骤 | 过滤非法引用 |
| `confidence` | 0~1 数值 | `null` |

`resource_type` 由 `device_requirement` 与 `manual_required` 推导，**不信任**模型的
`resource_type`，从而保证 `task.schema.json` 的 `allOf` 不变式（device/hybrid 必须有
device_requirement，manual/wait 必须没有）永远成立。

## 5. 温度与采样策略

- `temperature = 0`：结构化抽取要的是确定性，不要创造性；重试用同一输入得到可复现结果；
- 单次调用、单轮：菜谱步骤独立，不依赖多轮上下文；后续如需多菜组合，通过「多菜并行调度」
  的规划层而非解析层完成；
- 失败即失败：模型返回空、无 JSON、HTTP 失败都抛 `ParsedTaskError`，由 API 映射为
  422 `PARSE_FAILED`，**不会**静默降级为错误排程。规则兜底只兜「字段缺失」，不兜「整段解析失败」。

## 6. 通知生成机制中的 Prompt（可选项）

通知先由规则层生成**结构化事实**（触发时间、设备、温度、动作），见
`app/notifications.py`。如需大模型润色，约束是：

- 模型**不得**改变 `trigger_offset_sec`、`device_id`、`action`、`temperature_c` 等事实字段；
- 只允许把「3 分钟后需要：翻炒红烧排骨」这类事实文案改写为更自然的表达；
- 润色输出仍须通过 `notification.schema.json`，失败则回退到规则文案。

当前实现已把规则文案本身打磨为「精准、简洁、可操作 + 相对时间」的形态（见
`notifications.py` 与 `execution/diff.py`），因此润色是可选增强而非必需项。

## 7. 评测策略

- **离线标注集**：`data/annotations/` 目录预留 `gold / predictions / reports` 三级结构，
  解析结果与 Gold Label 对比，产出「设备 / 时间 / 依赖 / 人工介入」四维准确率（Level 1）；
- **无标注也可自评**：`strict` 模式会把缺失字段标记为 `missing` 并拒绝进入调度器，字段级
  `field_status` 分布本身即可作为解析覆盖率报告；
- **回归基线**：`test_llm_parser.py` 用假客户端验证字段覆盖、依赖解析、非法输出回退，保证
  Prompt 或覆盖规则变更不破坏输出合法性。
