import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { Block } from '../../types';
import { PedalShell } from './PedalShell';

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

export const SignalChain = () => {
  const blocks = useAppStore((state) => state.blocks);
  const selectedId = useAppStore((state) => state.selectedBlockId);
  const pending = new Set(useAppStore((state) => state.pending));
  const selectBlock = useAppStore((state) => state.selectBlock);
  const toggleBlock = useAppStore((state) => state.toggleBlock);
  const setControl = useAppStore((state) => state.setControl);
  const setLink = useAppStore((state) => state.setLink);
  const moveBlock = useAppStore((state) => state.moveBlock);
  const availableBlocks = useAppStore((state) => state.availableBlocks);
  const addBlock = useAppStore((state) => state.addBlock);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [blocks.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeBlock = blocks.find((block) => block.id === activeId);

  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    if (event.over && event.active.id !== event.over.id) {
      moveBlock(String(event.active.id), String(event.over.id));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div
        ref={scrollRef}
        className={`signal-chain${overflowing ? ' signal-chain--overflow' : ''}`}
        aria-label="Signal chain"
      >
        <div className="signal-chain__inner">
          <SortableContext items={blocks.map((block) => block.id)} strategy={horizontalListSortingStrategy}>
            {blocks.map((block, index) => (
              <SortablePedal
                key={block.id}
                block={block}
                index={index}
                selected={selectedId === block.id}
                pending={pending}
                onSelect={() => selectBlock(block.id)}
                onToggle={() => toggleBlock(block.id)}
                onControlChange={(controlId, value) => setControl(controlId, value)}
                onLink={() => setLink(block.id, block.link !== 'parallel')}
              />
            ))}
          </SortableContext>
          <div className="chain-cable" aria-hidden="true" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="chain-add" aria-label="Add a block to the chain">
                <span className="chain-add__plus">+</span>
                <span>Add</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" sideOffset={8} align="start">
                <DropdownMenu.Label className="menu__label">Available blocks</DropdownMenu.Label>
                {availableBlocks.map((block) => (
                  <DropdownMenu.Item
                    key={block.id}
                    className="menu__item"
                    onSelect={() => addBlock(block.id)}
                  >
                    <span>
                      <strong>{block.label}</strong>
                      <small>{block.desc}</small>
                    </span>
                    <Plus size={12} />
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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
