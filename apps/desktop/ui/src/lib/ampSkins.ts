/**
 * Board-block skins for amp captures.
 *
 * The device only exposes the capture name, so the skin has to be inferred
 * from that name. Capture libraries are inconsistent: some use the full brand,
 * some use model names, and some use shorthand (`SLO`, `DMBL`, `Plexi`).
 * The leftmost maker mentioned in the name wins; at the same position, the
 * longest alias wins so phrases such as "Twin Sister" beat a bare "Twin".
 */
export type AmpSkinId =
  | '5150'
  | 'ampeg'
  | 'diezel'
  | 'dumble'
  | 'fender'
  | 'friedman'
  | 'marshall'
  | 'matchless'
  | 'mesa'
  | 'orange'
  | 'soldano'
  | 'vox'
  | 'generic';

export interface AmpSkin {
  id: AmpSkinId;
  /** Wordmark shown on the cabinet faceplate. */
  brand: string;
  /** Case-insensitive words or phrases that identify this maker. */
  aliases: readonly string[];
}

/**
 * Maker definitions. Array order is only a stable tie-breaker for aliases that
 * start at the same position and have the same length.
 */
export const AMP_SKINS: readonly AmpSkin[] = [
  {
    id: '5150',
    brand: '5150',
    aliases: [
      '5150',
      '5150iii',
      '5150 iii',
      'evh',
      'peavey 5150',
      'peavey 6505',
      '6505',
      '6534',
    ],
  },
  {
    id: 'soldano',
    brand: 'soldano',
    aliases: [
      'soldano',
      'sold',
      'slo',
      'slo100',
      'slo 100',
      'soldanoslo',
      'avenger',
      'lucky 7',
      'lucky7',
      'super lead overdrive',
    ],
  },
  {
    id: 'dumble',
    brand: 'DUMBLE',
    aliases: [
      'dumble',
      'dmbl',
      'overdrive special',
      'overdrivespecial',
      'dumbleods',
      'ods',
      'steel string singer',
      'steelstringsinger',
      'sss',
    ],
  },
  {
    id: 'matchless',
    brand: 'MATCHLESS',
    aliases: [
      'matchless',
      'match',
      'chieftain',
      'dc30',
      'dc 30',
      'hc30',
      'hc 30',
      'independence',
      'clubman',
      'lightning',
      'spitfire',
      'hurricane',
      'avalon',
    ],
  },
  {
    id: 'friedman',
    brand: 'FRIEDMAN',
    aliases: [
      'friedman',
      'be100',
      'be 100',
      'brown eye',
      'browneye',
      'dirty shirley',
      'dirtyshirley',
      'runt',
      'smallbox',
      'twin sister',
      'twinsister',
      'jj junior',
      'jjjunior',
      'pt20',
      'pt 20',
      'pink taco',
      'pinktaco',
    ],
  },
  {
    id: 'diezel',
    brand: 'Diezel',
    aliases: [
      'diezel',
      'dizl',
      'dizlvh4',
      'dizl vh4',
      'vh4',
      'vh2',
      'herbert',
      'einstein',
      'hagen',
      'dmoll',
      'd moll',
      'big max',
      'bigmax',
    ],
  },
  {
    id: 'orange',
    brand: 'ORANGE',
    aliases: [
      'orange',
      'rockerverb',
      'tiny terror',
      'tinyterror',
      'dual terror',
      'dualterror',
      'dark terror',
      'darkterror',
      'th30',
      'th100',
      'ad30',
      'ad140',
      'or15',
      'or50',
      'thunderverb',
      'brent hinds',
      'brenthinds',
    ],
  },
  {
    id: 'mesa',
    brand: 'MESA',
    aliases: [
      'mesa',
      'boogie',
      'bogie',
      'rectifier',
      'dual rectifier',
      'dual rec',
      'triple rectifier',
      'triple rec',
      'mark i',
      'mark ii',
      'mark iii',
      'mark iv',
      'mark v',
      'mark 2',
      'mark 3',
      'mark 4',
      'mark 5',
      'lonestar',
      'lone star',
      'stiletto',
      'roadster',
      'road king',
      'roadking',
      'california tweed',
      'badlander',
      'jp2c',
      'jp 2c',
      'fillmore',
      'tc50',
      'tc 50',
    ],
  },
  {
    id: 'vox',
    brand: 'VOX',
    aliases: [
      'vox',
      'ac30',
      'ac 30',
      'voxac30',
      'ac15',
      'ac 15',
      'voxac15',
      'ac10',
      'ac 10',
      'voxac10',
      'ac4',
      'ac 4',
      'voxac4',
      'top boost',
      'topboost',
      'cambridge',
      'berkeley',
      'night train',
      'nighttrain',
      'valvetronix',
      'pathfinder',
    ],
  },
  {
    id: 'marshall',
    brand: 'Marshall',
    aliases: [
      'marshall',
      'marshal',
      'mars',
      'plexi',
      'plex',
      'jcm',
      'jcm800',
      'jcm 800',
      'jcm900',
      'jcm 900',
      'jcm2000',
      'jcm 2000',
      'jmp',
      'jtm',
      'jtm45',
      'jtm 45',
      '1959',
      '1987',
      '2203',
      '2204',
      '800',
      '900',
      'dsl',
      'dsl100',
      'dsl 100',
      'dsl40',
      'dsl 40',
      'dsl20',
      'dsl 20',
      'tsl',
      'tsl100',
      'tsl 100',
      'jubilee',
      'silver jubilee',
      'valvestate',
      'super lead',
      'superlead',
      'lead series',
    ],
  },
  {
    id: 'fender',
    brand: 'Fender',
    aliases: [
      'fender',
      'fndr',
      'twin',
      'twin reverb',
      'deluxe',
      'deluxe reverb',
      'bassman',
      'vibroverb',
      'princeton',
      'princeton reverb',
      'champ',
      'super reverb',
      'bandmaster',
      'vibrolux',
      'pro reverb',
      'tweed',
      'silverface',
      'blackface',
      'blues jr',
      'blues junior',
      'blues deluxe',
      'deville',
      'hrd',
      'drri',
      'trri',
      'srri',
      'prri',
      'bfsr',
      'bfdr',
      'bfpr',
      'sfdr',
      'sfvr',
    ],
  },
  {
    id: 'ampeg',
    brand: 'Ampeg',
    aliases: [
      'ampeg',
      'svt',
      'svt classic',
      'svtclassic',
      'svt3pro',
      'svt4pro',
      'svt7pro',
      'svtavalanche',
      'v4',
      'v 4',
      'v40',
      'v 40',
      'reverberocket',
      'reverb rocket',
      'gemini',
      'b15',
      'b 15',
      'b15n',
      'b15r',
      'portaflex',
      'ba115',
      'ba 115',
      'pf50t',
      'pf 50t',
    ],
  },
];

/** Fallback when no maker matches. */
export const GENERIC_AMP_SKIN: AmpSkin = {
  id: 'generic',
  brand: 'AMP',
  aliases: [],
};

const BY_ID = new Map<AmpSkinId, AmpSkin>([
  ...AMP_SKINS.map((skin) => [skin.id, skin] as const),
  [GENERIC_AMP_SKIN.id, GENERIC_AMP_SKIN],
]);

export const ampSkinById = (id: AmpSkinId): AmpSkin => BY_ID.get(id) ?? GENERIC_AMP_SKIN;

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface AliasRule {
  skin: AmpSkin;
  text: string;
  order: number;
}

/**
 * Flattened and pre-normalized once at module load. This replaces the old
 * nested priority loop and its per-call alias normalization.
 */
const ALIAS_RULES: readonly AliasRule[] = AMP_SKINS.flatMap((skin, order) =>
  skin.aliases.flatMap((alias) => {
    const text = normalize(alias);
    return text ? [{ skin, text, order }] : [];
  }),
);

interface NameToken {
  text: string;
  start: number;
}

const tokenize = (normalized: string): NameToken[] => {
  const tokens: NameToken[] = [];
  const matcher = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(normalized)) !== null) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
};

const findPhrase = (normalized: string, phrase: string): number => {
  const found = ` ${normalized} `.indexOf(` ${phrase} `);
  return found < 0 ? -1 : found;
};

const findToken = (tokens: readonly NameToken[], alias: string): number => {
  for (const token of tokens) {
    if (token.text === alias) return token.start;
    // Catches concatenated capture names such as "JCM800" or "MesaDualRec".
    if (alias.length >= 4 && token.text.startsWith(alias)) return token.start;
    if (alias.length >= 4 && token.text.includes(alias)) return token.start;
  }
  return -1;
};

interface AliasMatch {
  skin: AmpSkin;
  position: number;
  length: number;
  order: number;
}

const findBestMatch = (normalized: string): AliasMatch | null => {
  const tokens = tokenize(normalized);
  let best: AliasMatch | null = null;

  for (const rule of ALIAS_RULES) {
    const position = rule.text.includes(' ')
      ? findPhrase(normalized, rule.text)
      : findToken(tokens, rule.text);
    if (position < 0) continue;

    const length = rule.text.length;
    if (
      !best ||
      position < best.position ||
      (position === best.position && length > best.length) ||
      (position === best.position && length === best.length && rule.order < best.order)
    ) {
      best = { skin: rule.skin, position, length, order: rule.order };
    }
  }

  return best;
};

const SKIN_CACHE = new Map<string, AmpSkin>();
const SKIN_CACHE_LIMIT = 256;

/**
 * Return the skin for a capture/model name, or the generic skin when nothing
 * matches. The leftmost maker wins; matching is case-insensitive and tolerant
 * of punctuation. Results are cached because the board polls and re-renders
 * the same model names repeatedly.
 */
export const ampSkinFor = (model?: string | null): AmpSkin => {
  const key = model ?? '';
  const cached = SKIN_CACHE.get(key);
  if (cached) return cached;

  const normalized = normalize(key);
  const skin = normalized
    ? findBestMatch(normalized)?.skin ?? GENERIC_AMP_SKIN
    : GENERIC_AMP_SKIN;

  if (SKIN_CACHE.size >= SKIN_CACHE_LIMIT) SKIN_CACHE.clear();
  SKIN_CACHE.set(key, skin);
  return skin;
};
