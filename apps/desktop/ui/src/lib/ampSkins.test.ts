import { describe, expect, it } from 'vitest';
import { ampSkinFor, type AmpSkinId } from './ampSkins';

const skin = (model: string): AmpSkinId => ampSkinFor(model).id;

describe('ampSkinFor', () => {
  it.each<[string, AmpSkinId]>([
    ['Match Brave Hi D 3', 'matchless'],
    ['64 Vibroverb D 2', 'fender'],
    ['Dumble Pack A', 'dumble'],
    ['Twin Clean', 'fender'],
    ['Dumble PNAM Clean', 'dumble'],
    ['Tweed PNAM', 'fender'],
    ['Purple Plexi', 'marshall'],
    ['5150', '5150'],
    ['Bass Ampeg', 'ampeg'],
    ['JTM 45', 'marshall'],
    ['JCM 800', 'marshall'],
    ['Plexi Lead', 'marshall'],
    ['AC30 Chime', 'vox'],
    ['AC30 Top Boost', 'vox'],
    ['Deluxe Reverb', 'fender'],
    ['Princeton Clean', 'fender'],
    ['Bassman', 'fender'],
    ['Bandmaster', 'fender'],
    ['Matchless DC30', 'matchless'],
    ['Vox Night Train', 'vox'],
    ['Friedman BE', 'friedman'],
    ['Diezel VH4', 'diezel'],
    ['Mesa Dual Rec', 'mesa'],
    ['Orange Rockerverb', 'orange'],
    ['Soldano SLO', 'soldano'],
    ['Dumble ODS', 'dumble'],
    ['Fender Champ', 'fender'],
    ['Ampeg SVT', 'ampeg'],
    ['Marshall 1959BJA SUPER BOWL SET', 'marshall'],
  ])('maps %s to %s', (model, expected) => {
    expect(skin(model)).toBe(expected);
  });

  it.each<[string, AmpSkinId]>([
    ['SLO', 'soldano'],
    ['SLO-100', 'soldano'],
    ['SOLD', 'soldano'],
    ['DMBL', 'dumble'],
    ['Plexi', 'marshall'],
    ['Match', 'matchless'],
    ['6505', '5150'],
    ['VH4', 'diezel'],
    ['BE-100', 'friedman'],
    ['AC30', 'vox'],
    ['JCM800', 'marshall'],
    ['JTM45', 'marshall'],
    ['DC30', 'matchless'],
    ['SVT', 'ampeg'],
    ['ODS', 'dumble'],
    ['Rectifier', 'mesa'],
    ['Rockerverb', 'orange'],
  ])('handles shorthand %s', (model, expected) => {
    expect(skin(model)).toBe(expected);
  });

  it.each<[string, AmpSkinId]>([
    ['68 Mars Plexi PA D 4', 'marshall'],
    ['Edgy Plex', 'marshall'],
    ['800 Lo Gain', 'marshall'],
    ['M6100_10_CR_B_JCM800_3D', 'marshall'],
    ['FNDR BFSR VB Edge WRM2 CAB FREE', 'fender'],
    ['[AMP] DiZLVH4-CH4 Lead the Way', 'diezel'],
    ['MESADUAL - RED - VINTAGE - GAIN 7', 'mesa'],
    ['PEAVEY 6505PLUS GREEN CRUNCH 2', '5150'],
    ['EVH-Stealth100-Dialled', '5150'],
    ['Bogie IIC Thrash', 'mesa'],
    ['AP-AC30_06_Ch1 Bright On V3 TC7', 'vox'],
    ['Dumble Steel SS Clean', 'dumble'],
  ])('handles hardware fixture name %s', (model, expected) => {
    expect(skin(model)).toBe(expected);
  });

  it('handles concatenated, punctuated, and mixed-case names', () => {
    expect(skin('AC30TopBoost')).toBe('vox');
    expect(skin('MesaDualRec')).toBe('mesa');
    expect(skin('FenderTwin')).toBe('fender');
    expect(skin('soldano-slo-100')).toBe('soldano');
    expect(skin('DUMBLE ODS')).toBe('dumble');
    expect(skin('  marshall   plexi  ')).toBe('marshall');
  });

  it('uses the leftmost maker and prefers the longest alias at the same position', () => {
    expect(skin('Fender Match')).toBe('fender');
    expect(skin('Match Fender')).toBe('matchless');
    expect(skin('Sold Marshall')).toBe('soldano');
    expect(skin('Marshall Sold')).toBe('marshall');
    expect(skin('Fender Friedman')).toBe('fender');
    expect(skin('Friedman Fender')).toBe('friedman');
    expect(skin('Fender Ampeg')).toBe('fender');
    expect(skin('Ampeg Fender')).toBe('ampeg');
    expect(skin('Fender Matchless')).toBe('fender');
    expect(skin('Matchless Fender')).toBe('matchless');
    expect(skin('Fender Twin Sister')).toBe('fender');
    expect(skin('Twin Sister')).toBe('friedman');
    expect(skin('Friedman Twin Sister')).toBe('friedman');
    expect(skin('Fender Twin Reverb')).toBe('fender');
    expect(skin('Matchless Chieftain')).toBe('matchless');
  });

  it('falls back to generic for unknown makers and empty names', () => {
    for (const model of [
      'Bogner Ecstasy',
      'Trainwreck',
      'Two-Rock',
      'Carol Ann',
      'Bad Cat',
      'Dr Z Maz',
      'Supro Thunderbolt',
      'Gallien Krueger',
      'Darkglass B7K',
      'Studio Flat',
      'Headphones',
      'Lo-Fi Room',
      'Wet Only',
      'Null Test',
    ]) {
      expect(skin(model)).toBe('generic');
    }
    expect(ampSkinFor().id).toBe('generic');
    expect(ampSkinFor('').id).toBe('generic');
    expect(ampSkinFor('   ').id).toBe('generic');
    expect(ampSkinFor(null).id).toBe('generic');
  });

  it('does not match short aliases inside unrelated words', () => {
    expect(skin('Slope Face')).toBe('generic');
    expect(skin('Odds and Ends')).toBe('generic');
  });
});
