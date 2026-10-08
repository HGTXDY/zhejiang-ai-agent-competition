interface Props { onAgent: () => void; onManual: () => void }

function AgentIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.5 18.5 4 20l1.5-3.5A7.8 7.8 0 0 1 3 10.8C3 6.5 7 3 12 3s9 3.5 9 7.8-4 7.7-9 7.7c-1.7 0-3.3-.4-4.5-1Z" /><path d="m12 6.5.8 2.2L15 9.5l-2.2.8L12 12.5l-.8-2.2L9 9.5l2.2-.8L12 6.5Z" /></svg>
}

function ManualIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 4.5h12v15H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
}

export default function PlanningModeChooser({ onAgent, onManual }: Props) {
  return <section className="mode-chooser" aria-label="选择规划方式">
    <button className="mode-card agent-mode" onClick={onAgent}>
      <div className="mode-card-top"><span className="mode-icon"><AgentIcon /></span><span className="mode-kicker">AGENT 智能规划</span></div>
      <div className="mode-card-copy"><strong>自然语言驱动规划</strong><p>输入用餐诉求，自动解析菜谱、校验设备约束，输出协同烹饪时序。</p></div>
      <span className="mode-action">开始规划 <b>→</b></span>
    </button>
    <button className="mode-card manual-mode" onClick={onManual}>
      <div className="mode-card-top"><span className="mode-icon"><ManualIcon /></span><span className="mode-kicker">手动精确配置</span></div>
      <div className="mode-card-copy"><strong>自定义时序编排</strong><p>挑选菜品组合，配置人数、厨具与时间，手动微调烹饪执行方案。</p></div>
      <span className="mode-action">进入编排 <b>→</b></span>
    </button>
  </section>
}
