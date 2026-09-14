import { Bot, Clock3 } from 'lucide-react';

export function PanelHeader({ icon: Icon, eyebrow, title }: { icon: typeof Bot; eyebrow: string; title: string }) {
  return <div className="panel-header"><span className="panel-icon"><Icon size={18} /></span><div><small>{eyebrow}</small><h2>{title}</h2></div></div>;
}

export function EmptyState({ icon: Icon, text }: { icon: typeof Clock3; text: string }) {
  return <div className="empty-state"><Icon size={21} /><span>{text}</span></div>;
}
