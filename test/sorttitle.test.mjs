import test from 'node:test';
import assert from 'node:assert/strict';
import { sortTitle } from '../sorttitle.js';

test('strips a leading article (A / An / The)', () => {
  assert.equal(sortTitle('The Winter of the Witch'), 'winter of the witch');
  assert.equal(sortTitle('A Study in Scarlet'), 'study in scarlet');
  assert.equal(sortTitle('An Anime Chef Cookbook'), 'anime chef cookbook');
});

test('is case-insensitive for the article', () => {
  assert.equal(sortTitle('THE Girl in the Tower'), 'girl in the tower');
  assert.equal(sortTitle('the escape room'), 'escape room');
});

test('only strips a leading article, not mid-title or article-like prefixes', () => {
  assert.equal(sortTitle('Theory of Everything'), 'theory of everything'); // "The" not a whole word
  assert.equal(sortTitle('Angela’s Ashes'), 'angela’s ashes');           // "An" not a whole word
  assert.equal(sortTitle('James and the Giant Peach'), 'james and the giant peach');
});

test('ignores leading punctuation/quotes', () => {
  assert.equal(sortTitle('"The Nightmare Before Dinner"'), 'nightmare before dinner');
  assert.equal(sortTitle('  The Anime Chef'), 'anime chef');
});

test('does not reduce a bare article to empty', () => {
  assert.equal(sortTitle('The'), 'the');
  assert.equal(sortTitle('A'), 'a');
});

test('sorts a list the way a reader expects', () => {
  const titles = ['The Winter of the Witch', 'Belladonna', 'A Study in Scarlet', 'James', 'The Girl in the Tower'];
  const sorted = [...titles].sort((a, b) => sortTitle(a).localeCompare(sortTitle(b)));
  assert.deepEqual(sorted, ['Belladonna', 'The Girl in the Tower', 'James', 'A Study in Scarlet', 'The Winter of the Witch']);
});
