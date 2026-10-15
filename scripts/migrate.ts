import { openDatabase } from '../src/db';
openDatabase().close();
console.log('Database migrated.');
