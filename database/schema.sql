CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('athlete', 'coach')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS programs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sport TEXT NOT NULL,
  level TEXT NOT NULL,
  goal TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  training_days INTEGER NOT NULL DEFAULT 0,
  recovery_days INTEGER NOT NULL DEFAULT 0,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS workouts (
  id SERIAL PRIMARY KEY,
  program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  distance_km REAL NOT NULL DEFAULT 0,
  intensity TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  day_of_week TEXT NOT NULL,
  scheduled_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS coach_requests (
  id SERIAL PRIMARY KEY,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (athlete_id, coach_id)
);

CREATE TABLE IF NOT EXISTS program_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sport TEXT NOT NULL,
  level TEXT NOT NULL,
  goal TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  training_days INTEGER NOT NULL DEFAULT 0,
  recovery_days INTEGER NOT NULL DEFAULT 0,
  coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

CREATE TABLE IF NOT EXISTS program_assignments (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES program_templates(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  UNIQUE (template_id, athlete_id)
);

CREATE TABLE IF NOT EXISTS program_template_workouts (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES program_templates(id) ON DELETE CASCADE,
  sport TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  distance_km REAL NOT NULL DEFAULT 0,
  intensity TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  day_of_week TEXT NOT NULL,
  scheduled_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS assignment_id INTEGER,
  ADD COLUMN IF NOT EXISTS template_workout_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workouts'::regclass AND conname = 'workouts_assignment_id_fkey'
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_assignment_id_fkey
      FOREIGN KEY (assignment_id) REFERENCES program_assignments(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workouts'::regclass AND conname = 'workouts_template_workout_id_fkey'
  ) THEN
    ALTER TABLE workouts
      ADD CONSTRAINT workouts_template_workout_id_fkey
      FOREIGN KEY (template_workout_id) REFERENCES program_template_workouts(id) ON DELETE CASCADE;
  END IF;
END;
$$;
