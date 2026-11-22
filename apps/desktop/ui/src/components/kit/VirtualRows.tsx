import { Fragment, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const VIRTUALIZE_AFTER = 80;
const ROW_ESTIMATE = 46;
const OVERSCAN = 12;

interface VirtualRowsProps<T> {
  rows: T[];
  scrollElement: HTMLElement | null;
  columnCount: number;
  renderRow: (row: T) => ReactNode;
}

const VirtualTableRows = <T,>({
  rows,
  scrollElement,
  columnCount,
  renderRow,
}: VirtualRowsProps<T>) => {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
  });
  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0),
  );
  const spacer = (height: number, key: string) =>
    height > 0 ? (
      <tr key={key} aria-hidden="true">
        <td colSpan={columnCount} style={{ height, padding: 0, border: 0 }} />
      </tr>
    ) : null;

  return (
    <>
      {spacer(paddingTop, 'virtual-top')}
      {items.map((item) => (
        <Fragment key={item.key}>{renderRow(rows[item.index])}</Fragment>
      ))}
      {spacer(paddingBottom, 'virtual-bottom')}
    </>
  );
};

/**
 * Render table rows directly for small lists and virtualize large ones.
 * Spacer rows keep the native table layout while only visible rows mount.
 */
export const VirtualRows = <T,>(props: VirtualRowsProps<T>) =>
  props.rows.length <= VIRTUALIZE_AFTER ? (
    <>{props.rows.map((row) => props.renderRow(row))}</>
  ) : (
    <VirtualTableRows {...props} />
  );
