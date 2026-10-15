import { controlDb } from '../src/db/control';
const db = controlDb();
console.log(
  JSON.stringify(
    db
      .prepare("SELECT id,deletionAt AS at FROM principals WHERE status IN ('deleting','deleted')")
      .all(),
    null,
    2,
  ),
);
db.close();
