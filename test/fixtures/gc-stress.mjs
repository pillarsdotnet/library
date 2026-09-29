// Run by gc-stress.test.mjs in a child process, so an abort fails that test
// rather than taking the whole test file down with it.
//
// Every prepared statement is a native object wrapped in a JS one. Dropping
// 300,000 of them while allocating hard makes V8 collect them on its own, which
// runs their native destructors inside garbage collection. That is where
// nodejs/node#65446 aborts: an addon built on node::ObjectWrap, compiled against
// Node 24.19.0 or later headers. An explicit global.gc() does not reproduce it;
// the collection has to be allocation driven, so there is none here.
import Database from 'better-sqlite3';

const db = new Database(':memory:');
let junk = [];
for (let i = 0; i < 300000; i++) {
  db.prepare('SELECT ?').get(i);
  junk.push({ a: i });
  if (junk.length > 1000) junk = [];
}
console.log('survived');
