# 比赛官方资料

本目录和 `data/official/` 保存用户提供的比赛原始资料，作为项目开发与评测的输入基线。

## 文件清单

| 文件 | 类型 | 用途 |
|---|---|---|
| `官方赛题细则-方太人工智能专项赛.docx` | 官方原始文件 | 比赛背景、评分标准、提交要求和赛题约束 |
| `../product/灶序智能烹饪调度Agent-PRD-V1.0.docx` | 项目 PRD | 产品范围、交互和验收基线 |
| `../../data/official/recipes_100.csv` | 官方/比赛资料原始数据 | 100 道菜谱解析评测输入 |
| `../../data/official/device_parameters_reference.json` | 官方/比赛资料原始数据 | 设备参数、模式和能力参考 |

## 数据边界

- `data/official/recipes_100.csv` 是本次收到的 100 道菜谱原始资料；在未完成字段核对、解析标注和版本登记前，不直接视为已经完成的 Gold Label 标注集。
- `device_parameters_reference.json` 是设备能力参考，后端接入前需要完成中文设备名到 V1 枚举的映射，并由双方 Review；当前已知歧义见 `data/official/MAPPING_NOTES.md`。
- `fixtures/v1/` 中的四道菜数据是开发阶段的**临时合成 Demo Fixture**，不是官方 100 道菜谱，也不是比赛 Gold Label 数据。
- 官方原始文件只允许追加新版本，不应覆盖修改；任何清洗、归一化或标注结果放在独立目录并保留来源文件和处理脚本。

## 版本与校验

添加或替换官方资料时记录：

- 来源路径和获取日期；
- SHA-256；
- 文件行数/记录数；
- 清洗或转换脚本版本；
- 是否经过双方 Review。
