interface Props { label: string; value: string; hint: string; accent?: string }
export function MetricCard({ label, value, hint, accent = 'gold' }: Props) {
  return <div className={`metric-card ${accent}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>
}
