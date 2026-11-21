import { SignalChain } from '../../components/kit/SignalChain';
import { Inspector } from '../../components/kit/Inspector';
import { PresetRail } from '../../components/kit/PresetRail';
import { UtilityRail } from '../../components/kit/UtilityRail';
import { useAppStore } from '../../stores/useAppStore';

export const BoardView = () => {
  const blocks = useAppStore((state) => state.blocks);
  const connection = useAppStore((state) => state.connection);
  const fixed = blocks.filter((block) => block.fixed).length;

  return (
    <div className="board-view">
      <section className="chain-hero panel" aria-label="Signal chain">
        <header className="view-head chain-hero__head">
          <div className="view-head__title">
            <span className="eyebrow">Board / signal path</span>
            <h1>Signal chain</h1>
            <span className="view-head__meta mono">
              {blocks.length} blocks · {fixed} fixed · {connection.connected ? 'live' : 'offline'}
            </span>
          </div>
          <div className="view-head__hint">
            <span>drag to reorder</span>
            <span>right-click to bypass</span>
            {blocks.length > 10 && <span>scroll for more</span>}
          </div>
        </header>
        <SignalChain />
      </section>

      <div className="board-workbench">
        <PresetRail />
        <div className="board-workbench__main">
          <div className="workbench-meta">
            <span className="eyebrow">Inspector</span>
          </div>
          <Inspector />
        </div>
        <UtilityRail />
      </div>
    </div>
  );
};
