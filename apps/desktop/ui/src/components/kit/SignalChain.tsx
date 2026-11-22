import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  adjacentEmptySlot,
  chainSlotId,
  parseChainSlotId,
  type ChainSlotRef,
} from '../../lib/chainSlots';
import { useAppStore } from '../../stores/useAppStore';
import type { Block } from '../../types';
import { PedalShell } from './PedalShell';

// Empty slots sit between the sortable pedals, so the built-in list strategy
// would move fixed pedals over the gaps while dragging. Keep the chain still
// and let the drag overlay plus the highlighted drop slot show the result.
const stayInPlace: SortingStrategy = () => null;

const SortablePedal = ({
  block,
  index,
  selected,
  pending,
  onSelect,
  onToggle,
  onControlChange,
  onLink,
}: {
  block: Block;
  index: number;
  selected: boolean;
  pending: Set<string>;
  onSelect: () => void;
  onToggle: () => void;
  onControlChange: (controlId: string, value: number) => void;
  onLink: () => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    disabled: block.fixed,
  });

  return (
    <div className="chain-node" ref={setNodeRef}>
      {index > 0 && (
        <div className={`chain-cable${block.link === 'parallel' ? ' chain-cable--parallel' : ''}`}>
          <button
            type="button"
            aria-label={`Link into ${block.label}: ${block.link}. Change link`}
            title={`${block.link === 'parallel' ? 'Parallel' : 'Series'} link — click to change`}
            onClick={(event) => {
              event.stopPropagation();
              onLink();
            }}
          >
            <ArrowLeftRight size={9} />
          </button>
        </div>
      )}
      <div
        style={{
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.35 : 1,
        }}
      >
        <PedalShell
          block={block}
          selected={selected}
          pending={pending}
          onSelect={onSelect}
          onToggle={onToggle}
          onControlChange={onControlChange}
          dragHandleProps={{ ...attributes, ...listeners }}
        />
      </div>
    </div>
  );
};

const AvailableBlocksMenu = ({
  label,
  onSelect,
  children,
}: {
  label: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) => {
  const availableBlocks = useAppStore((state) => state.availableBlocks);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={8} align="start">
          <DropdownMenu.Label className="menu__label">{label}</DropdownMenu.Label>
          {availableBlocks.length === 0 ? (
            <DropdownMenu.Item className="menu__item" disabled>
              <span>
                <strong>No blocks available</strong>
                <small>Every block is already in the chain.</small>
              </span>
            </DropdownMenu.Item>
          ) : (
            availableBlocks.map((block) => (
              <DropdownMenu.Item
                key={block.id}
                className="menu__item"
                onSelect={() => onSelect(block.id)}
              >
                <span>
                  <strong>{block.label}</strong>
                  <small>{block.desc}</small>
                </span>
                <Plus size={12} />
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

const EmptyChainSlot = ({
  slot,
  highlight,
}: {
  slot: ChainSlotRef;
  highlight: boolean;
}) => {
  const addBlock = useAppStore((state) => state.addBlock);
  const { setNodeRef, isOver } = useDroppable({ id: chainSlotId(slot) });
  const active = isOver || highlight;

  return (
    <div ref={setNodeRef} className={`chain-slot${active ? ' chain-slot--over' : ''}`}>
      <AvailableBlocksMenu
        label="Add a block here"
        onSelect={(id) => addBlock(id, slot)}
      >
        <button
          type="button"
          className="chain-slot__add"
          aria-label={`Add a block to empty chain slot ${slot.row + 1}:${slot.col + 1}`}
        >
          <Plus size={14} aria-hidden="true" />
          <span>Empty</span>
        </button>
      </AvailableBlocksMenu>
    </div>
  );
};

type ChainItem =
  | { kind: 'block'; id: string; block: Block; row: number; col: number }
  | { kind: 'slot'; id: string; slot: ChainSlotRef; row: number; col: number };

export const SignalChain = () => {
  const blocks = useAppStore((state) => state.blocks);
  const selectedId = useAppStore((state) => state.selectedBlockId);
  const pending = new Set(useAppStore((state) => state.pending));
  const connection = useAppStore((state) => state.connection);
  const emptySlots = useAppStore((state) => state.emptySlots);
  const selectBlock = useAppStore((state) => state.selectBlock);
  const toggleBlock = useAppStore((state) => state.toggleBlock);
  const setControl = useAppStore((state) => state.setControl);
  const setLink = useAppStore((state) => state.setLink);
  const moveBlock = useAppStore((state) => state.moveBlock);
  const addBlock = useAppStore((state) => state.addBlock);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const deviceLayout =
    connection.mode === 'device' &&
    blocks.every((block) => block.slotRow != null && block.slotCol != null);

  const chainItems = useMemo<ChainItem[]>(() => {
    if (!deviceLayout) {
      return blocks.map((block) => ({
        kind: 'block',
        id: block.id,
        block,
        row: 0,
        col: 0,
      }));
    }
    return [
      ...blocks.map((block) => ({
        kind: 'block' as const,
        id: block.id,
        block,
        row: block.slotRow!,
        col: block.slotCol!,
      })),
      ...emptySlots.map((slot) => ({
        kind: 'slot' as const,
        id: chainSlotId(slot),
        slot,
        row: slot.row,
        col: slot.col,
      })),
    ].sort((left, right) => left.row - right.row || left.col - right.col);
  }, [blocks, emptySlots, deviceLayout]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setOverflowing(element.scrollWidth > element.clientWidth + 2);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [chainItems.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeBlock = blocks.find((block) => block.id === activeId);
  const previewSlotId = useMemo(() => {
    if (!activeBlock || !overId) return null;
    const direct = parseChainSlotId(overId);
    if (direct) return chainSlotId(direct);
    const targetBlock = blocks.find((block) => block.id === overId);
    if (!targetBlock) return null;
    const adjacent = adjacentEmptySlot(activeBlock, targetBlock, blocks, emptySlots);
    return adjacent ? chainSlotId(adjacent) : null;
  }, [activeBlock, overId, blocks, emptySlots]);

  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const onDragOver = (event: DragOverEvent) =>
    setOverId(event.over ? String(event.over.id) : null);
  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    setOverId(null);
    if (event.over && event.active.id !== event.over.id) {
      moveBlock(String(event.active.id), String(event.over.id));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setOverId(null);
      }}
    >
      <div
        ref={scrollRef}
        className={`signal-chain${overflowing ? ' signal-chain--overflow' : ''}`}
        aria-label="Signal chain"
      >
        <div className="signal-chain__inner">
          <SortableContext items={blocks.map((block) => block.id)} strategy={stayInPlace}>
            {chainItems.map((item, index) =>
              item.kind === 'block' ? (
                <SortablePedal
                  key={item.id}
                  block={item.block}
                  index={index}
                  selected={selectedId === item.id}
                  pending={pending}
                  onSelect={() => selectBlock(item.id)}
                  onToggle={() => toggleBlock(item.id)}
                  onControlChange={(controlId, value) => setControl(controlId, value)}
                  onLink={() => setLink(item.id, item.block.link !== 'parallel')}
                />
              ) : (
                <EmptyChainSlot
                  key={item.id}
                  slot={item.slot}
                  highlight={previewSlotId === item.id}
                />
              ),
            )}
          </SortableContext>
          <div className="chain-cable" aria-hidden="true" />
          <AvailableBlocksMenu label="Available blocks" onSelect={(id) => addBlock(id)}>
            <button type="button" className="chain-add" aria-label="Add a block to the chain">
              <span className="chain-add__plus">+</span>
              <span>Add</span>
            </button>
          </AvailableBlocksMenu>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeBlock ? (
          <div className="drag-overlay">
            <PedalShell
              block={activeBlock}
              selected={false}
              pending={new Set()}
              onSelect={() => undefined}
              onToggle={() => undefined}
              onControlChange={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};
