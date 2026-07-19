// Initial genre taxonomy. Top-level genres have `children` (subgenres).
// Used to seed the genres table on first run; users can add more via the app.
export const GENRE_SEED = [
  {
    name: 'Fantasy',
    definition: 'Includes supernatural entities, magic, or other plot elements that contradict current science.',
    children: [
      { name: 'Historical', definition: 'Set in the past but recognizably the same world we live in.' },
      { name: 'Contemporary', definition: "Set in earth's present." },
      { name: 'High', definition: 'Set in a different world.' },
    ],
  },
  {
    name: 'Realism',
    definition: 'No plot elements contradict current science.',
    children: [
      { name: 'Contemporary', definition: "Set in earth's present." },
      { name: 'Near-future', definition: 'Set in the near future, with nothing that contradicts current science.' },
      { name: 'Distant future', definition: 'Set in the distant future, with nothing that contradicts current science.' },
    ],
  },
  {
    name: 'Science Fiction',
    definition: 'Some plot elements depend on scientific discoveries that have not yet happened, but which, at the time of writing, were considered reasonably possible.',
    children: [
      { name: 'Time Travel', definition: 'Plot centers on travel to/from the distant past or future.' },
      { name: 'Space Opera', definition: 'Plot centers on interplanetary, interstellar, and/or intergalactic travel.' },
      { name: 'Aliens', definition: 'Contact, conflict, or cooperation with non-human entities is a major plot point.' },
      { name: 'Alternative', definition: 'Similar to Fantasy/Historical but contradicts known history, not known science.' },
    ],
  },
  { name: 'Mystery', definition: 'Crime procedurals, spy novels, whodunnits.', children: [] },
  { name: 'Thriller', definition: 'Suspense, chase, action.', children: [] },
  { name: 'Occupational', definition: 'Focus on a specific industry, occupation, or vocation.', children: [] },
];
