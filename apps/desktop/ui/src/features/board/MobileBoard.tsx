import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eraser,
  Plus,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Inspector } from '../../components/kit/Inspector';
import { AvailableBlocksMenu } from '../../components/kit/SignalChain';
import { useAppStore } from '../../stores/useAppStore';
import type { Block } from '../../types';

const MobileBlockCard = ({
  block,
  index,
  onSelect,
}: {
  block: Block;
  index: number;
  onSelect: () => void;
}) => (
  <button
    type="button"
    className={`mobile-block-card${block.fixed ? ' mobile-block-card--fixed' : ''}`}
    data-block-id={block.id}
    data-family={block.family}
    onClick={onSelect}
  >
    <span className="mobile-block-card__number mono">{index + 1}</span>
    <span className="mobile-block-card__dot" aria-hidden="true" />
    <span className="mobile-block-card__text">
      <strong>{block.label}</strong>
      <small>{block.model || block.shortName}</small>
    </span>
    <span className={`mobile-block-card__state${block.on ? ' is-on' : ''}`}>
      {block.on ? 'On' : 'Off'}
    </span>
    {block.fixed && <span className="mobile-block-card__fixed">Fixed</span>}
    <span className="sr-only">Open controls</span>
    <ChevronRight size={16} aria-hidden="true" />
  </button>
);

export const MobileBoard = () => {
  const blocks = useAppStore((state) => state.blocks);
  const selectedBlockId = useAppStore((state) => state.selectedBlockId);
  const pane = useAppStore((state) => state.mobileBoardPane);
  const setPane = useAppStore((state) => state.setMobileBoardPane);
  const selectBlock = useAppStore((state) => state.selectBlock);
  const addBlock = useAppStore((state) => state.addBlock);
  const clearChain = useAppStore((state) => state.clearChain);
  const connection = useAppStore((state) => state.connection);
  const [confirmClear, setConfirmClear] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const previousPane = useRef(pane);

  const selected = blocks.find((block) => block.id === selectedBlockId);
  const showEditor = pane === 'edit' && Boolean(selected);
  const fixed = blocks.filter((block) => block.fixed).length;
  const movable = blocks.length - fixed;

  // Move focus with the pane change so keyboard and screen-reader users are
  // not dropped on an unmounted card. Android Back resets the pane directly in
  // the store, so this also restores focus to the block that was open.
  useEffect(() => {
    if (previousPane.current === pane) return;
    previousPane.current = pane;
    requestAnimationFrame(() => {
      if (pane === 'edit') {
        document
          .querySelector<HTMLButtonElement>('.inspector--mobile .inspector__back-btn')
          ?.focus({ preventScroll: true });
        return;
      }
      const card = Array.from(
        gridRef.current?.querySelectorAll<HTMLButtonElement>('.mobile-block-card') ?? [],
      ).find((element) => element.dataset.blockId === selectedBlockId);
      card?.focus({ preventScroll: true });
    });
  }, [pane, selectedBlockId]);

  if (showEditor) {
    return (
      <div className="mobile-board mobile-board--editor">
        <Inspector mobile onBack={() => setPane('chain')} />
      </div>
    );
  }

  return (
    <div className="mobile-board mobile-board--chain">
      <section className="mobile-chain panel" aria-label="Signal chain">
        <header className="mobile-chain__head">
          <div>
            <span className="eyebrow">Board / signal path</span>
            <h1>Signal chain</h1>
            <span className="mobile-chain__meta mono">
              {blocks.length} blocks · {fixed} fixed ·{' '}
              {connection.connected ? 'live' : 'offline'}
            </span>
          </div>
          <div className="mobile-chain__actions">
            <AvailableBlocksMenu label="Add a block" onSelect={(id) => addBlock(id)}>
              <button type="button" className="btn btn--sm">
                <Plus size={13} /> Add
              </button>
            </AvailableBlocksMenu>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Chain actions"
                  title="Chain actions"
                >
                  <ChevronDown size={16} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" sideOffset={6} align="end">
                  <DropdownMenu.Label className="menu__label">
                    Signal chain
                  </DropdownMenu.Label>
                  <DropdownMenu.Item
                    className="menu__item menu__item--danger"
                    disabled={movable === 0}
                    onSelect={() => setConfirmClear(true)}
                  >
                    <span>
                      <strong>Clear chain</strong>
                      <small>Remove every movable block</small>
                    </span>
                    <Eraser size={12} />
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>

        {blocks.length === 0 ? (
          <div className="mobile-chain__empty">
            <p>No blocks loaded yet.</p>
            <span className="hint">
              Connect to a pedal, then add blocks here.
            </span>
          </div>
        ) : (
          <div className="mobile-chain__grid" ref={gridRef}>
            {blocks.map((block, index) => (
              <MobileBlockCard
                key={block.id}
                block={block}
                index={index}
                onSelect={() => {
                  selectBlock(block.id);
                  setPane('edit');
                }}
              />
            ))}
          </div>
        )}
        <p className="mobile-chain__hint hint">
          Tap a block to edit its controls. Swiping here cannot change a parameter.
        </p>
      </section>

      <Dialog.Root
        open={confirmClear}
        onOpenChange={setConfirmClear}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby={undefined}>
            <div className="dialog-head">
              <div>
                <Dialog.Title className="dialog-title">Clear signal chain?</Dialog.Title>
                <Dialog.Description className="hint">
                  Remove every movable block from the current patch. Fixed blocks
                  and connectors are preserved.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Close clear chain dialog"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="dialog-body">
              <p className="preflight__warning">
                <AlertTriangle size={12} aria-hidden="true" /> {movable} movable
                block{movable === 1 ? '' : 's'} will be removed.
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
