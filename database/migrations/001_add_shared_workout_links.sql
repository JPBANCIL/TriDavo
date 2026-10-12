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