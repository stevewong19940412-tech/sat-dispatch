const db = require('better-sqlite3')('./data/satplanning.db');
console.log(JSON.stringify(db.prepare("SELECT * FROM directPlans WHERE taskId=8").all(),null,1));
console.log(JSON.stringify(db.prepare("SELECT id,satName,company,company FROM candidates WHERE taskId=8 AND filtered=0 AND satName LIKE '%GAOFEN-9 04%'").all()));
console.log(JSON.stringify(db.prepare("SELECT id,satName,company,overpassTime,windowStart,windowEnd,slewDeg FROM candidates WHERE taskId=8 AND filtered=0 AND satName='GAOFEN-9 04'").all(),null,1));
console.log(db.prepare("PRAGMA table_info(directPlans)").all().map(c=>c.name).join(','));
