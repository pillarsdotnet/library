import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAuthor, sortTitle } from '../sorttitle.js';

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

test('files an author surname first, given name after', () => {
  assert.equal(sortAuthor('Frank Herbert'), 'herbert frank');
  assert.equal(sortAuthor('Kevin J. Anderson'), 'anderson kevin j');
  assert.equal(sortAuthor('Homer'), 'homer');
});

test('the primary (first listed) author files the book; the rest tie-break', () => {
  assert.equal(sortAuthor('Frank Herbert, Kevin J. Anderson'), 'herbert frank kevin j anderson');
  assert.equal(sortAuthor('Terry Pratchett; Neil Gaiman'), 'pratchett terry neil gaiman');
  // Herbert alone, then Herbert with a co-author: the solo books file first.
  assert.ok(sortAuthor('Frank Herbert') < sortAuthor('Frank Herbert, Kevin J. Anderson'));
});

test('surname particles stay with the surname', () => {
  assert.equal(sortAuthor('Ursula K. Le Guin'), 'le guin ursula k');
  assert.equal(sortAuthor('Vincent van Gogh'), 'van gogh vincent');
  // …but a two-word name keeps its given name even when it looks like one.
  assert.equal(sortAuthor('Di Morrissey'), 'morrissey di');
});

test('generational suffixes do not change where a name files, only tie-break', () => {
  assert.equal(sortAuthor('Martin Luther King Jr.'), 'king martin luther jr');
  assert.equal(sortAuthor('Davis Grubb III'), 'grubb davis iii');
});

test('an empty or missing author files first, quietly', () => {
  assert.equal(sortAuthor(''), '');
  assert.equal(sortAuthor(null), '');
});
