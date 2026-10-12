const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const databaseDirectory = __dirname;
const database = new Database(path.join(databaseDirectory, 'tridavo.db'));
database.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(databaseDirectory, 'schema.sql'), 'utf8');
database.exec(schema);

// Add schedule fields without replacing an existing local database.
const workoutColumns = database.prepare('PRAGMA table_info(workouts)').all().map(column => column.name);
if (!workoutColumns.includes('scheduled_date')) database.exec('ALTER TABLE workouts ADD COLUMN scheduled_date TEXT');
if (!workoutColumns.includes('notes')) database.exec("ALTER TABLE workouts ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
if (!workoutColumns.includes('assignment_id')) database.exec('ALTER TABLE workouts ADD COLUMN assignment_id INTEGER');
if (!workoutColumns.includes('template_workout_id')) database.exec('ALTER TABLE workouts ADD COLUMN template_workout_id INTEGER');

module.exports = database;
