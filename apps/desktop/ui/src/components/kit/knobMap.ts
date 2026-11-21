import type { Block, Control, ControlGroup } from '../../types';

/**
 * The shell shows at most three live controls. Priority is a UI decision:
 * authored per family, tolerant of firmware naming, and never a preset write.
 */
const PRIORITY: Record<string, string[]> = {
  drive: ['gain', 'treble', 'lvl', 'mid', 'low', 'mix'],
  amp: ['gain', 'low', 'treble', 'mid', 'lvl', 'vol'],
  comp: ['thresh', 'ratio', 'lvl', 'attack', 'release'],
  gate: ['thresh', 'decay', 'attack', 'hold'],
  delay: ['dlytime', 'fdbk', 'mix', 'level'],
  reverb: ['mix', 'decay', 'predelay', 'lvl'],
  mod: ['rate', 'depth', 'mix'],
  cab: ['lvl', 'blend', 'locut', 'hicut'],
  pitch: ['pitch', 'mix'],
  utility: [],
};

const ALIASES: Record<string, string> = {
  drive: 'gain',
  tone: 'treble',
  high: 'treble',
  treble: 'treble',
  level: 'lvl',
  volume: 'lvl',
  vol: 'lvl',
  lvl1: 'lvl',
  makeup: 'lvl',
  feedback: 'fdbk',
  time: 'dlytime',
  pre_dly: 'predelay',
  dpth: 'depth',
  lo_cut: 'locut',
  hi_cut: 'hicut',
  threshold: 'thresh',
  sensitivity: 'thresh',
  blend: 'blend',
};

const collectControls = (block: Block): Control[] => {
  const out: Control[] = [...block.controls];
  const walk = (groups: ControlGroup[]) => {
    for (const group of groups) {
      if (block.secondLane && group.id === block.secondLane.id) continue;
      out.push(...group.controls);
      if (group.groups) walk(group.groups);
    }
  };
  walk(block.groups);
  return out.filter(
    (control) =>
      control.kind === 'float' ||
      control.kind === 'pfloat' ||
      control.kind === 'number',
  );
};

export const getBlockKnobIds = (block: Block): string[] => {
  const names = PRIORITY[block.family] ?? [];
  const controls = collectControls(block);
  const chosen: Control[] = [];

  for (const wanted of names) {
    const found = controls.find(
      (item) => item.name === wanted || ALIASES[item.name] === wanted,
    );
    if (found && !chosen.includes(found)) chosen.push(found);
  }
  for (const item of controls) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen.slice(0, 3).map((item) => item.id);
};

export const blockControl = (block: Block, id: string): Control | undefined => {
  const direct = block.controls.find((item) => item.id === id);
  if (direct) return direct;
  for (const group of block.groups) {
    const found = group.controls.find((item) => item.id === id);
    if (found) return found;
    for (const nested of group.groups ?? []) {
      const deep = nested.controls.find((item) => item.id === id);
      if (deep) return deep;
    }
  }
  return block.secondLane?.controls.find((item) => item.id === id);
};

export const allBlockControls = (block: Block): Control[] => {
  const out = [...block.controls];
  const walk = (groups: ControlGroup[]) => {
    for (const group of groups) {
      out.push(...group.controls);
      if (group.groups) walk(group.groups);
    }
  };
  walk(block.groups);
  if (block.secondLane) out.push(...block.secondLane.controls);
  return out;
};
