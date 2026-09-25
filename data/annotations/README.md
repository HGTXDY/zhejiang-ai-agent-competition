# 官方菜谱解析标注与评测

本目录存放从 `data/official/recipes_100.csv` 派生的标注和评测产物。官方原始 CSV 不得覆盖或编辑。

## 目录

- `schema/annotation-record.schema.json`：逐菜谱标注记录格式；
- `templates/recipes_100.jsonl`：由官方 100 道菜谱生成的人工标注模板；
- `gold/`：完成审核后的 Gold Label，只允许提交已复核记录；
- `review/`：低置信度和设备映射歧义记录；
- `reports/`：字段级评测报告。

## 生成模板

```bash
python scripts/build_annotation_template.py
```

模板不会猜测设备、时间或依赖，所有任务初始为空并标记为 `unannotated`。这避免把自动推断误当成官方 Gold Label。

## 评测口径

`evaluate_parser.py` 对以下字段分别统计准确率：

- `device_type`
- `mode`
- `temperature_c`
- `duration_sec`
- `predecessors`
- `manual_required`
- `manual_duration_sec`
- `interruptible`

默认温度/时长容差为 5；依赖按集合比较；缺失字段不视为正确。评测输入为两个 JSONL 文件，每行一个菜谱记录。

示例：

```bash
python scripts/evaluate_parser.py \
  --gold data/annotations/gold/recipes_100.jsonl \
  --predictions data/annotations/predictions/recipes_100.jsonl \
  --output data/annotations/reports/latest.json
```

在 Gold Label 尚未完成前，不生成虚假的准确率报告。
