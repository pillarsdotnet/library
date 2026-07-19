// Initial genre taxonomy for a brand-new (empty) database. This mirrors the
// live taxonomy; it is only used to seed a fresh install (existing databases
// are never re-seeded — see db.js).
export const GENRE_SEED = [
  {
    name: 'Maturity',
    definition: 'Common parent of child genres describing the age or maturity of principal protagonists.',
    children: [
      { name: 'Adult', definition: 'Protagonists are adult, or act from adult motivations.' },
      { name: 'Child', definition: 'Books intended to be read to young children or by beginning readers.' },
      { name: 'Middle-Grade', definition: 'Protagonists are literate but prepubescent.' },
      { name: 'Young-Adult', definition: 'Protagonists are between puberty and majority, usually from the ages of 13 to 18.' },
    ],
  },
  {
    name: 'Nonfiction',
    definition: 'Grounded in real-world facts, events, and people rather than imagination. Factually accurate and based on real historical, scientific, or empirical information.',
    children: [
      { name: 'Cookbook', definition: 'Cooking recipes' },
      { name: 'History', definition: 'A recounting of real historical events.' },
      { name: 'Politics', definition: 'Protagonists include one or more well-known politicians.' },
      { name: 'Technical', definition: 'Written to inform or educate on a particular subject rather than to relate historical fact. Includes DIY, or How to, and most educational course material.' },
    ],
  },
  {
    name: 'Realism',
    definition: 'Parent for subgenres describing the degree to which a book agrees or contradicts with known science and recorded history.',
    children: [
      { name: 'Alternative', definition: 'Contradicts history but not science. What if a major historical event had gone differently?' },
      { name: 'Future', definition: 'Science Fiction depends on scientific discovery which was plausible at the time of writing but has not yet occurred.' },
      { name: 'Magical', definition: 'Includes supernatural entities, magic, or other plot elements that contradict known science.' },
      { name: 'Mundane', definition: 'Agrees with and does not extend beyond known scientific laws and principles. ' },
    ],
  },
  {
    name: 'Theme',
    definition: 'Parent for subgenres which describe the overall theme of a book ',
    children: [
      { name: 'Aliens', definition: 'Contact, conflict, or cooperation with non-human entities is a major plot point.' },
      { name: 'Horror', definition: 'The intent of the story is to frighten the reader by exploring humanity\'s deepest fears, taboos, and the unknown.' },
      { name: 'Life', definition: 'True, real-life writing centered around one person. Includes biographies, autobiographies, and memoirs.' },
      { name: 'Military', definition: 'Centers on military life, combat, or warfare.' },
      { name: 'Mystery', definition: 'Crime procedurals, spy novels, whodunnits.' },
      { name: 'Occupational', definition: 'Focused on the culture within a specific industry, occupation, or vocation, to the extent that the culture itself becomes a recognizable character in the story.' },
      { name: 'Opinion', definition: 'Blogs or opinions' },
      { name: 'Romance', definition: 'Plot centers on the romantic interest between two or more main protagonists.' },
      { name: 'Sport', definition: 'Centers on a specific sport or organized competition.' },
      { name: 'Thriller', definition: 'Suspense, chase, action.' },
      { name: 'Time-Travel', definition: 'Plot centers on travel to/from the distant past or future.' },
    ],
  },
  {
    name: 'Timeframe',
    definition: 'Parent for child genres describing the timeframe of a book\'s events',
    children: [
      { name: 'Civil-War', definition: 'Includes or references events related to the American Civil War.' },
      { name: 'Contemporary', definition: 'Set in the present or recent past.' },
      { name: 'Distant-Future', definition: 'Set in the distant future.' },
      { name: 'Historical', definition: 'Set in the distant past.' },
      { name: 'Near-Future', definition: 'Set in the near future.' },
    ],
  },
  {
    name: 'World',
    definition: 'Parent for subgenres which describe the world in which the story takes place',
    children: [
      { name: 'Alternative', definition: 'Set in a different world not recognizable as Earth.' },
      { name: 'Earth', definition: 'Recognizably the same world we live in.' },
      { name: 'Space', definition: 'Set in a space ship or includes more than one planet.' },
    ],
  },
];
