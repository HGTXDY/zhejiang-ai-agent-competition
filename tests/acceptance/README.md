# M1 自动验收

这组测试先锁定契约和固定 Fixture 的可重复验收口径，后续接入真实 API 时保持相同断言。

## 当前覆盖

- V1 Schema 与所有示例载荷；
- 正常四菜场景；
- 设备不可用场景；
- 设备模式冲突场景；
- Fixture manifest 与业务错误码一致性。

## 运行

```bash
python -m pip install 'jsonschema[format]>=4.23,<5' pytest
PYTHONPATH=. pytest -q tests/acceptance
```

这部分不把四道菜 Fixture 称为官方 Gold Label；它们只是稳定的 Demo/契约验收数据。
