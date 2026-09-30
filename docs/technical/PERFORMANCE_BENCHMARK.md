# Scheduler Performance Benchmark

Run the real CP-SAT scheduler repeatedly against a deterministic fixture:

```bash
PYTHONPATH=backend python scripts/benchmark_scheduler.py \
  --fixture fixtures/v1/four-dish-normal.json \
  --iterations 20 \
  --warmup 2
```

Optional local budget gate:

```bash
PYTHONPATH=backend python scripts/benchmark_scheduler.py --max-p95-ms 5000
```

The output reports wall-clock `min`, `p50`, `p95`, and `max` in milliseconds.
The benchmark checks that every run returns `OPTIMAL` or `FEASIBLE`. It is an
engineering regression signal and **not** an official competition score; the
competition evaluation environment and protocol remain authoritative.
