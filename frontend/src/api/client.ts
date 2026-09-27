import { addDish, getSchedule, postEvent } from '../mock/api'
import type { DashboardSchedule, DashboardTask, Notification } from '../types/contracts'

export interface CookFlowApi {
  getSchedule(): Promise<DashboardSchedule>
  postEvent(task: DashboardTask, status: DashboardTask['status']): Promise<{ task: DashboardTask; notification: Notification }>
  addDish(): Promise<{ tasks: DashboardTask[]; notification: Notification }>
}

/** API boundary: swap this implementation for HttpCookFlowApi when FastAPI is ready. */
export const api: CookFlowApi = { getSchedule, postEvent, addDish }
