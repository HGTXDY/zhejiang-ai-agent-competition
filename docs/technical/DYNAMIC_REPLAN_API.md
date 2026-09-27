# Dynamic Replan API

## Endpoint

```text
POST /v1/replans
```

The first implementation is stateless. The caller supplies the original
`schedule_request` and the current `schedule-response` together with one V1
execution event:

```json
{
  "event": {"...": "event-request-v1"},
  "schedule_request": {"...": "schedule-request-v1"},
  "current_schedule": {"...": "schedule-response-v1"}
}
```

The service performs:

```text
replan-request schema
→ event schema
→ schedule-request schema and business rules
→ execution state transition
→ locked-task and device-availability constraints
→ CP-SAT replan
→ schedule diff and disruption metrics
→ replan-response
```

## Lock policy

- `COMPLETED` and explicitly `locked` tasks keep their start offset and assigned
  device resources.
- A task reported as delayed gets a start-time floor based on its previous
  start plus `delay_sec`.
- `DEVICE_UNAVAILABLE` marks the device unavailable for the candidate solve;
  mutable tasks may be reassigned, while locked tasks remain unchanged and are
  reported for operational handling.
- `DISH_ADDED` extends the scheduling request with the validated event tasks.

## Explicit non-goals

This endpoint does not provide persistence, authentication, a queue, or an LLM
parser. A production deployment should store schedules and event idempotency
keys outside the process before exposing this endpoint publicly.
