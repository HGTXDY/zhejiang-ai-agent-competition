import type { DashboardSchedule, TimelineResource } from '../types/contracts'

export const resources: TimelineResource[] = [
  { id: 'operator_1', label: '操作员 · 主厨', tone: 'gold' },
  { id: 'stove_1', label: '灶具 · 01', tone: 'cyan' },
  { id: 'steamer_1', label: '蒸箱 · 01', tone: 'violet' },
  { id: 'oven_1', label: '烤箱 · 01', tone: 'slate' },
]

export const initialSchedule: DashboardSchedule = {
  schema_version: '1.0',
  request_id: 'cookflow_demo_request_001',
  schedule_id: 'cookflow_demo_001',
  solver: { status: 'OPTIMAL', objective_value: 2460, best_bound: 2460, gap: 0, duration_ms: 42 },
  metrics: {
    makespan_sec: 2460,
    finish_spread_sec: 180,
    max_continuous_manual_sec: 240,
    device_conflicts: 0,
    dependency_violations: 0,
    target_delay_sec: 0,
  },
  validation: { valid: true, errors: [] },
  timings_ms: { parse: 0, validation: 1, solve: 42, notification: 0, total: 43 },
  notifications: [],
  tasks: [
    { task_id: 'ribs_prepare', dish_id: 'braised_ribs', action: '排骨预处理', start_offset_sec: 0, end_offset_sec: 180, assigned_resources: ['operator_1'], status: 'COMPLETED', locked: true, notification_points: [] },
    { task_id: 'ribs_blanch', dish_id: 'braised_ribs', action: '排骨焯水', start_offset_sec: 180, end_offset_sec: 780, assigned_resources: ['stove_1', 'operator_1'], status: 'RUNNING', locked: true, notification_points: [] },
    { task_id: 'fish_prepare', dish_id: 'steamed_fish', action: '鲈鱼腌制', start_offset_sec: 0, end_offset_sec: 300, assigned_resources: ['operator_1'], status: 'COMPLETED', locked: true, notification_points: [] },
    { task_id: 'fish_steam', dish_id: 'steamed_fish', action: '清蒸鲈鱼', start_offset_sec: 300, end_offset_sec: 960, assigned_resources: ['steamer_1'], status: 'PENDING', locked: false, notification_points: [] },
    { task_id: 'wings_prepare', dish_id: 'baked_wings', action: '鸡翅装盘', start_offset_sec: 300, end_offset_sec: 540, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] },
    { task_id: 'wings_bake', dish_id: 'baked_wings', action: '烤鸡翅', start_offset_sec: 540, end_offset_sec: 1440, assigned_resources: ['oven_1'], status: 'PENDING', locked: false, notification_points: [] },
    { task_id: 'broccoli_prepare', dish_id: 'garlic_broccoli', action: '西兰花改刀', start_offset_sec: 780, end_offset_sec: 960, assigned_resources: ['operator_1'], status: 'PENDING', locked: false, notification_points: [] },
    { task_id: 'broccoli_stir', dish_id: 'garlic_broccoli', action: '蒜蓉西兰花', start_offset_sec: 960, end_offset_sec: 1260, assigned_resources: ['stove_1', 'operator_1'], status: 'PENDING', locked: false, notification_points: [] },
  ],
}
