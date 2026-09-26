import { addDish, getSchedule, postEvent } from '../mock/api'
import type { Notification, ScheduleResponse, ScheduleTask } from '../types/contracts'

export interface CookFlowApi {
  getSchedule(): Promise<ScheduleResponse>
  postEvent(task: ScheduleTask, status: ScheduleTask['status']): Promise<{ task: ScheduleTask; notification: Notification }>
  addDish(): Promise<{ tasks: ScheduleTask[]; notification: Notification }>
}

/** API boundary: swap this implementation for HttpCookFlowApi when FastAPI is ready. */
export const api: CookFlowApi = { getSchedule, postEvent, addDish }
