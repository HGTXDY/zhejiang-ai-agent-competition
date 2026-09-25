# 四道菜确定性调度 Fixture V1

本目录为 Issue #3 的固定输入，不依赖大模型，用于校验器、调度器、API 和前端 Mock 的并行开发。

## 菜品

- 红烧排骨 `braised_ribs`
- 清蒸鲈鱼 `steamed_fish`
- 蒜蓉西兰花 `garlic_broccoli`
- 烤鸡翅 `baked_wings`

正常场景配置一个操作者、两个独立灶眼、一个蒸箱和一个烤箱。所有任务均显式标注设备、模式、温度、时长、依赖、人工片段和 Parser 字段来源。

## 场景

| 文件 | 预期 |
|---|---|
| `four-dish-normal.json` | Schema 和业务校验通过，可直接作为基础调度器输入 |
| `four-dish-resource-insufficient.json` | 烤箱不可用，预期 `DEVICE_TYPE_UNAVAILABLE` |
| `four-dish-mode-conflict.json` | 鱼要求设备不支持的高压蒸模式，预期 `DEVICE_MODE_UNSUPPORTED` |

`manifest.json` 是机器可读的预期结果清单。负例必须保持 Schema 合法，仅在跨对象业务校验阶段失败。

## 校验

```bash
python scripts/validate_contracts.py
```
