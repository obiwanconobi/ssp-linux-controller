import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlertTriangle, ChevronDown, Eraser, X } from 'lucide-react';
import { useState } from 'react';
import { SignalChain } from '../../components/kit/SignalChain';
import { Inspector } from '../../components/kit/Inspector';
import { PresetRail } from '../../components/kit/PresetRail';
import { UtilityRail } from '../../components/kit/UtilityRail';
import { useAppStore } from '../../stores/useAppStore';

export const BoardView = () => {
  const blocks = useAppStore((state) => state.blocks);
  const connection = useAppStore((state) => state.connection);
  const clearChain = useAppStore((state) => state.clearChain);
  const [confirmClear, setConfirmClear] = useState(false);
  const fixed = blocks.filter((block) => block.fixed).length;
  const movable = blocks.length - fixed;

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
          <div className="view-head__actions">
            <div className="view-head__hint">
              <span>drag to reorder</span>
              <span>right-click to bypass</span>
              {blocks.length > 10 && <span>scroll for more</span>}
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  aria-label="Chain actions"
                >
                  Chain…
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" sideOffset={6} align="end">
                  <DropdownMenu.Label className="menu__label">Signal chain</DropdownMenu.Label>
                  <DropdownMenu.Item
                    className="menu__item menu__item--danger"
                    disabled={movable === 0}
                    onSelect={() => setConfirmClear(true)}
                  >
                    <span>
                      <strong>Clear chain</strong>
                      <small>Remove every movable block</small>
                    </span>
                    <Eraser size={12} aria-hidden="true" />
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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

      <Dialog.Root open={confirmClear} onOpenChange={setConfirmClear}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby={undefined}>
            <div className="dialog-head">
              <div>
                <Dialog.Title className="dialog-title">Clear signal chain?</Dialog.Title>
                <Dialog.Description className="hint">
                  Remove every movable block from the current patch. Fixed blocks and chain
                  connectors are preserved. This cannot be undone unless you save the patch
                  first.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label="Close clear chain dialog">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="dialog-body">
              <p className="preflight__warning">
                <AlertTriangle size={12} aria-hidden="true" /> {movable} movable block
                {movable === 1 ? '' : 's'} will be removed.
              </p>
            </div>
            <div className="dialog-foot">
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  clearChain();
                  setConfirmClear(false);
                }}
              >
                Clear chain
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
