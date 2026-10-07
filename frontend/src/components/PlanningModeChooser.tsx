interface Props { onAgent: () => void; onManual: () => void }
export default function PlanningModeChooser({ onAgent, onManual }: Props) {
  return <section className="mode-chooser" aria-label="选择规划方式">
    <button className="mode-card agent-mode" onClick={onAgent}>
      <span className="mode-icon">✦</span><span className="mode-kicker">推荐 · Agent 智能规划</span>
      <strong>直接告诉我，今晚怎么吃</strong>
      <p>用一句话说菜单、开饭时间和厨房条件。我会追问缺失信息，再调用菜谱解析、设备校验与排程工具。</p>
      <span className="mode-action">开始对话 <b>→</b></span>
    </button>
    <button className="mode-card manual-mode" onClick={onManual}>
      <span className="mode-icon">☷</span><span className="mode-kicker">手动精确配置</span>
      <strong>按步骤选择与设置</strong>
      <p>从菜谱库选择 3～5 道菜，逐项填写人数、设备与开饭时间，适合精确调整。</p>
      <span className="mode-action">进入配置 <b>→</b></span>
    </button>
  </section>
}
