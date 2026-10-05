const deviceLabels: Record<string, string> = {
  stove: '灶具', steamer: '蒸箱', oven: '烤箱', refrigerator: '冰箱', dishwasher: '洗碗机',
  range_hood: '烟机', water_purifier: '净水机', operator: '人工操作', manual: '人工操作',
}

const modeLabels: Record<string, string> = {
  stir_fry: '炒制', fry: '煎制', boil: '煮制', stew: '炖煮', steam: '蒸制', bake: '烘烤',
  roast: '烤制', chill: '冷藏', freeze: '冷冻', wash: '清洗', exhaust: '排烟', purify: '净水',
  prepare: '准备', cut: '切配', mix: '拌制', wait: '等待',
}

const resourceLabels: Record<string, string> = {
  operator: '操作台', stove: '灶具', steamer: '蒸箱', oven: '烤箱', refrigerator: '冰箱',
  dishwasher: '洗碗机', range_hood: '烟机', water_purifier: '净水机',
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (!hours) return `${Math.round(seconds / 60)} 分钟`
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function formatDevice(value?: string | null) {
  if (!value) return '通用设备'
  return deviceLabels[value] ?? '厨房设备'
}

export function formatMode(value?: string | null) {
  if (!value) return ''
  return modeLabels[value] ?? '设备工作'
}

export function formatResource(value: string) {
  const match = value.match(/^(.+?)_(\d+)$/)
  if (!match) return resourceLabels[value] ?? '厨房资源'
  const [, type, index] = match
  return `${resourceLabels[type] ?? '厨房设备'} ${Number(index)}`
}

export function formatResources(values: string[]) {
  return values.length ? values.map(formatResource).join('、') : '人工操作'
}

export function apiModeLabel(mode: string) {
  return mode.toLowerCase().includes('mock') ? '演示模式' : '服务已连接'
}
