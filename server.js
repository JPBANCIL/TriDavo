const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const database = require('./database/database');
const PgSessionStore = require('connect-pg-simple')(session);

const app = express();
app.use(express.json());
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
const port = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production');
}

app.use(async (request, response, next) => {
  try {
    await database.initialize();
    next();
  } catch (error) {
    console.error('Database initialization failed:', error);
    response.status(503).json({ message: 'The service is temporarily unavailable.' });
  }
});
app.use(session({
  store: new PgSessionStore({
    pool: database.pool,
    createTableIfMissing: true,
    tableName: 'sessions'
  }),
  secret: process.env.SESSION_SECRET || 'tridavo-local-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function requireLogin(request, response, next) {
  if (!request.session.userId) return response.status(401).json({ message: 'Please log in to continue.' });
  next();
}

function registerRoute(method, route, ...handlers) {
  const wrappedHandlers = handlers.map(handler => handler.constructor.name === 'AsyncFunction'
    ? (request, response, next) => handler(request, response, next).catch(next)
    : handler);
  app[method](route, ...wrappedHandlers);
}

async function getUser(request) {
  return database.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(request.session.userId);
}

function validRole(role) { return role === 'athlete' || role === 'coach'; }
function validText(value) { return typeof value === 'string' && value.trim().length > 0; }
function validNumber(value) { return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0; }
function validCompleted(value) { return value === true || value === false || value === 1 || value === 0 || value === '1' || value === '0'; }

async function getProgram(programId) {
  if (typeof programId === 'string' && /^shared-\d+$/.test(programId)) return getSharedProgram(programId);
  return database.prepare('SELECT * FROM programs WHERE id = ?').get(programId);
}

async function getSharedProgram(programId) {
  const assignmentId = Number(String(programId).replace('shared-', ''));
  return database.prepare(`${sharedProgramSelect} WHERE pa.id = ?`).get(assignmentId);
}

function canManageProgram(user, program) {
  if (!program) return false;
  if (program.template_id) return user.role === 'coach' && program.coach_id === user.id;
  if (user.role === 'coach') return program.coach_id === user.id;
  return program.athlete_id === user.id && !program.coach_id;
}

function canAccessProgram(user, program) {
  if (program?.template_id) return program.coach_id === user.id || (user.role === 'athlete' && program.athlete_id === user.id);
  return Boolean(program && (program.athlete_id === user.id || program.coach_id === user.id));
}

registerRoute('post', '/api/auth/register', async (request, response) => {
  const { name, email, password, role } = request.body;
  if (!validText(name) || !validText(email) || !validText(password) || !validRole(role) || password.length < 6) {
    return response.status(400).json({ message: 'Enter a name, valid email, password of at least 6 characters, and account type.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await database.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name.trim(), email.trim().toLowerCase(), passwordHash, role);
    request.session.userId = result.lastInsertRowid;
    response.status(201).json({ message: 'Account created.', user: publicUser(await getUser(request)) });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ message: 'An account with that email already exists.' });
    response.status(500).json({ message: 'Could not create your account.' });
  }
});

registerRoute('post', '/api/auth/login', async (request, response) => {
  const { email, password } = request.body;
  const user = await database.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) return response.status(401).json({ message: 'Email or password is incorrect.' });
  request.session.userId = user.id;
  response.json({ message: 'Welcome back.', user: publicUser(user) });
});

app.post('/api/auth/logout', (request, response) => request.session.destroy(() => response.json({ message: 'Logged out.' })));
registerRoute('get', '/api/auth/me', async (request, response) => {
  const user = request.session.userId ? await getUser(request) : null;
  response.json({ user: user ? publicUser(user) : null });
});

function programWithPeople(program) {
  return { ...program, coach: program.coach_id ? { id: program.coach_id, name: program.coach_name, email: program.coach_email } : null, athlete: { id: program.athlete_id, name: program.athlete_name, email: program.athlete_email } };
}
const programSelect = `SELECT p.*, a.name athlete_name, a.email athlete_email, c.name coach_name, c.email coach_email FROM programs p JOIN users a ON a.id = p.athlete_id LEFT JOIN users c ON c.id = p.coach_id`;
const sharedProgramSelect = `SELECT ('shared-' || pa.id) id, pa.id assignment_id, pt.id template_id, pa.assigned_at, pt.name, pt.sport, pt.level, pt.goal, pt.start_date, pt.end_date, pt.training_days, pt.recovery_days, pa.athlete_id, pt.coach_id, pt.created_at, a.name athlete_name, a.email athlete_email, c.name coach_name, c.email coach_email FROM program_assignments pa JOIN program_templates pt ON pt.id = pa.template_id JOIN users a ON a.id = pa.athlete_id JOIN users c ON c.id = pt.coach_id`;

async function cloneTemplateWorkouts(templateId, assignmentId, athleteId) {
  const templates = await database.prepare('SELECT * FROM program_template_workouts WHERE template_id = ? ORDER BY id').all(templateId);
  const insertWorkout = database.prepare('INSERT INTO workouts (program_id, athlete_id, sport, workout_type, duration_minutes, distance_km, intensity, description, day_of_week, scheduled_date, notes, assignment_id, template_workout_id) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const workout of templates) await insertWorkout.run(athleteId, workout.sport, workout.workout_type, workout.duration_minutes, workout.distance_km, workout.intensity, workout.description, workout.day_of_week, workout.scheduled_date, workout.notes, assignmentId, workout.id);
}

async function assignTemplate(templateId, coachId, athleteIds) {
  const template = await database.prepare('SELECT id FROM program_templates WHERE id = ? AND coach_id = ?').get(templateId, coachId);
  if (!template) return { assigned: [], failed: athleteIds.map(athleteId => ({ athlete_id: athleteId, reason: 'Program not found or not managed by this coach.' })) };

  const assign = database.transaction(async () => {
    const assigned = [];
    const failed = [];
    for (const [index, athleteId] of athleteIds.entries()) {
      const savepoint = `athlete_assignment_${index}`;
      await database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const athlete = Number.isInteger(athleteId) && athleteId > 0 ? await database.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'athlete'").get(athleteId) : null;
        if (!athlete) {
          failed.push({ athlete_id: athleteId, reason: 'Athlete account not found.' });
        } else {
          const connection = await database.prepare("SELECT id FROM coach_requests WHERE coach_id = ? AND athlete_id = ? AND status = 'accepted'").get(coachId, athlete.id);
          if (!connection) failed.push({ athlete_id: athlete.id, name: athlete.name, reason: 'Athlete is not connected to this coach.' });
          else {
            const result = await database.prepare('INSERT INTO program_assignments (template_id, athlete_id) VALUES (?, ?) ON CONFLICT (template_id, athlete_id) DO NOTHING').run(templateId, athlete.id);
            if (!result.changes) failed.push({ athlete_id: athlete.id, name: athlete.name, reason: 'Program is already assigned to this athlete.' });
            else {
              await cloneTemplateWorkouts(templateId, result.lastInsertRowid, athlete.id);
              assigned.push({ athlete_id: athlete.id, name: athlete.name });
            }
          }
        }
        await database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        failed.push({ athlete_id: athleteId, reason: 'Assignment could not be saved.' });
      }
    }
    return { assigned, failed };
  });
  return assign();
}

registerRoute('get', '/api/programs', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const legacyRows = user.role === 'athlete' ? await database.prepare(`${programSelect} WHERE p.athlete_id = ?`).all(user.id) : await database.prepare(`${programSelect} WHERE p.coach_id = ?`).all(user.id);
  const sharedRows = user.role === 'athlete' ? await database.prepare(`${sharedProgramSelect} WHERE pa.athlete_id = ?`).all(user.id) : await database.prepare(`${sharedProgramSelect} WHERE pt.coach_id = ?`).all(user.id);
  const rows = legacyRows.concat(sharedRows).sort((left, right) => right.start_date.localeCompare(left.start_date));
  response.json({ programs: rows.map(programWithPeople) });
});

registerRoute('post', '/api/programs', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const { name, sport, level, goal, start_date, end_date, training_days, recovery_days, athlete_id, athlete_ids } = request.body;
  if (user.role === 'coach') {
    let requestedIds = athlete_ids;
    if (typeof requestedIds === 'string') {
      try { requestedIds = JSON.parse(requestedIds); } catch { requestedIds = null; }
    }
    const ids = Array.isArray(requestedIds) ? requestedIds.map(Number) : athlete_id === undefined ? [] : [Number(athlete_id)];
    if (!validText(name) || !validText(sport) || !validText(level) || !validText(goal) || !validText(start_date) || !validText(end_date) || !ids.length || ids.some(id => !Number.isInteger(id) || id < 1) || new Set(ids).size !== ids.length) return response.status(400).json({ message: 'Complete the program fields and select one or more athletes.' });
    const createAndAssign = database.transaction(async () => {
      const result = await database.prepare('INSERT INTO program_templates (name, sport, level, goal, start_date, end_date, training_days, recovery_days, coach_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name.trim(), sport.trim(), level.trim(), goal.trim(), start_date, end_date, Number(training_days) || 0, Number(recovery_days) || 0, user.id);
      const assignments = await assignTemplate(result.lastInsertRowid, user.id, ids);
      if (!assignments.assigned.length) throw Object.assign(new Error('No athletes received the program.'), { assignments });
      return { templateId: result.lastInsertRowid, ...assignments };
    });
    try {
      const result = await createAndAssign();
      return response.status(201).json({ message: `Program assigned to ${result.assigned.length} ${result.assigned.length === 1 ? 'athlete' : 'athletes'}.`, ...result });
    } catch (error) {
      if (error.assignments) return response.status(409).json({ message: error.message, assigned: [], failed: error.assignments.failed });
      return response.status(500).json({ message: 'Could not create and assign the program.' });
    }
  }
  const athleteId = user.role === 'athlete' ? user.id : Number(athlete_id);
  if (!validText(name) || !validText(sport) || !validText(level) || !validText(goal) || !validText(start_date) || !validText(end_date) || !athleteId) return response.status(400).json({ message: 'Please complete every program field.' });
  if (user.role === 'coach') {
    const connection = await database.prepare("SELECT id FROM coach_requests WHERE coach_id = ? AND athlete_id = ? AND status = 'accepted'").get(user.id, athleteId);
    if (!connection) return response.status(403).json({ message: 'You can only create programs for connected athletes.' });
  }
  const result = await database.prepare('INSERT INTO programs (name, sport, level, goal, start_date, end_date, training_days, recovery_days, athlete_id, coach_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name.trim(), sport, level, goal.trim(), start_date, end_date, Number(training_days) || 0, Number(recovery_days) || 0, athleteId, user.role === 'coach' ? user.id : null);
  response.status(201).json({ message: 'Program created.', programId: result.lastInsertRowid });
});

registerRoute('post', '/api/program-templates/:id/assignments', requireLogin, async (request, response) => {
  const user = await getUser(request);
  if (user.role !== 'coach') return response.status(403).json({ message: 'Only coaches can assign programs.' });
  const ids = request.body.athlete_ids;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isInteger(Number(id)) || Number(id) < 1) || new Set(ids.map(Number)).size !== ids.length) return response.status(400).json({ message: 'Select one or more valid athletes.' });
  const result = await assignTemplate(Number(request.params.id), user.id, ids.map(Number));
  if (!result.assigned.length) return response.status(409).json({ message: 'No athletes received the program.', ...result });
  response.status(result.failed.length ? 207 : 201).json({ message: `Program assigned to ${result.assigned.length} ${result.assigned.length === 1 ? 'athlete' : 'athletes'}.`, ...result });
});

registerRoute('get', '/api/programs/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const program = await getProgram(request.params.id);
  if (!canAccessProgram(user, program)) return response.status(404).json({ message: 'Program not found.' });
  const workouts = program.template_id
    ? await database.prepare('SELECT * FROM workouts WHERE assignment_id = ? ORDER BY COALESCE(scheduled_date, day_of_week), created_at').all(program.assignment_id)
    : await database.prepare('SELECT * FROM workouts WHERE program_id = ? AND athlete_id = ? ORDER BY day_of_week, created_at').all(program.id, program.athlete_id);
  response.json({ program: { ...programWithPeople(program), workouts } });
});

registerRoute('put', '/api/programs/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const program = await getProgram(request.params.id);
  if (!canAccessProgram(user, program)) return response.status(404).json({ message: 'Program not found.' });
  if (!canManageProgram(user, program)) return response.status(403).json({ message: 'You cannot edit this program.' });
  const fields = ['name', 'sport', 'level', 'goal', 'start_date', 'end_date', 'training_days', 'recovery_days'];
  const values = fields.map(field => request.body[field] ?? program[field]);
  const table = program.template_id ? 'program_templates' : 'programs';
  const id = program.template_id || program.id;
  await database.prepare(`UPDATE ${table} SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
  response.json({ message: 'Program updated.' });
});

registerRoute('delete', '/api/programs/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const result = await database.prepare('DELETE FROM programs WHERE id = ? AND athlete_id = ?').run(request.params.id, user.id);
  if (!result.changes) return response.status(404).json({ message: 'Program not found or cannot be deleted.' });
  response.json({ message: 'Program deleted.' });
});

registerRoute('get', '/api/workouts', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const workouts = await database.prepare('SELECT w.*, p.name program_name FROM workouts w LEFT JOIN programs p ON p.id = w.program_id WHERE w.athlete_id = ? ORDER BY COALESCE(w.scheduled_date, w.day_of_week), w.created_at').all(user.id);
  response.json({ workouts });
});

registerRoute('get', '/api/programs/:id/workouts', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const program = await getProgram(request.params.id);
  if (!canAccessProgram(user, program)) return response.status(404).json({ message: 'Program not found.' });
  const workouts = program.template_id
    ? await database.prepare('SELECT * FROM workouts WHERE assignment_id = ? ORDER BY COALESCE(scheduled_date, day_of_week), created_at').all(program.assignment_id)
    : await database.prepare('SELECT * FROM workouts WHERE program_id = ? AND athlete_id = ? ORDER BY COALESCE(scheduled_date, day_of_week), created_at').all(program.id, program.athlete_id);
  response.json({ workouts });
});

registerRoute('post', '/api/workouts', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const { program_id, sport, workout_type, duration_minutes, distance_km, intensity, description, day_of_week, scheduled_date, notes } = request.body;
  if (!validText(sport) || !validText(workout_type) || !validText(intensity) || !validText(day_of_week) || !validNumber(duration_minutes) || !validNumber(distance_km)) return response.status(400).json({ message: 'Please complete the workout fields with valid numbers.' });
  const program = program_id ? await getProgram(program_id) : null;
  if (program_id && !program) return response.status(400).json({ message: 'That program does not exist.' });
  if (program && !canManageProgram(user, program)) return response.status(403).json({ message: 'You cannot manage workouts in this program.' });
  if (!program && user.role !== 'athlete') return response.status(403).json({ message: 'Only athletes can create unassigned workouts.' });
  if (program?.template_id) {
    const createWorkout = database.transaction(async () => {
      const templateWorkout = await database.prepare('INSERT INTO program_template_workouts (template_id, sport, workout_type, duration_minutes, distance_km, intensity, description, day_of_week, scheduled_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(program.template_id, sport.trim(), workout_type.trim(), Number(duration_minutes), Number(distance_km), intensity.trim(), description || '', day_of_week.trim(), scheduled_date || null);
      const assignments = await database.prepare('SELECT id, athlete_id FROM program_assignments WHERE template_id = ?').all(program.template_id);
      const insertWorkout = database.prepare('INSERT INTO workouts (program_id, athlete_id, sport, workout_type, duration_minutes, distance_km, intensity, description, day_of_week, scheduled_date, notes, assignment_id, template_workout_id) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const assignment of assignments) await insertWorkout.run(assignment.athlete_id, sport.trim(), workout_type.trim(), Number(duration_minutes), Number(distance_km), intensity.trim(), description || '', day_of_week.trim(), scheduled_date || null, '', assignment.id, templateWorkout.lastInsertRowid);
    });
    await createWorkout();
    return response.status(201).json({ message: 'Workout added to all program assignments.' });
  }
  await database.prepare('INSERT INTO workouts (program_id, athlete_id, sport, workout_type, duration_minutes, distance_km, intensity, description, day_of_week, scheduled_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(program ? program.id : null, program ? program.athlete_id : user.id, sport.trim(), workout_type.trim(), Number(duration_minutes), Number(distance_km), intensity.trim(), description || '', day_of_week.trim(), scheduled_date || null, notes || '');
  response.status(201).json({ message: 'Workout added.' });
});

registerRoute('put', '/api/programs/:programId/workouts/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const program = await getProgram(request.params.programId);
  const workout = await database.prepare('SELECT * FROM workouts WHERE id = ? AND program_id = ? AND athlete_id = ?').get(request.params.id, request.params.programId, program?.athlete_id);
  const sharedWorkout = program?.template_id ? await database.prepare('SELECT * FROM workouts WHERE id = ? AND assignment_id = ?').get(request.params.id, program.assignment_id) : null;
  if (!program || !(program.template_id ? sharedWorkout : workout)) return response.status(404).json({ message: 'Scheduled workout not found.' });
  if (!canManageProgram(user, program)) return response.status(403).json({ message: 'You cannot edit this scheduled workout.' });
  const fields = ['sport', 'workout_type', 'duration_minutes', 'distance_km', 'intensity', 'description', 'day_of_week', 'scheduled_date', 'notes'];
  const targetWorkout = program.template_id ? sharedWorkout : workout;
  const values = fields.map(field => request.body[field] ?? targetWorkout[field]);
  if (!validText(values[0]) || !validText(values[1]) || !validText(values[4]) || !validText(values[6]) || !validNumber(values[2]) || !validNumber(values[3])) return response.status(400).json({ message: 'Scheduled workout details are invalid.' });
  if (program.template_id) {
    const updateSharedWorkout = database.transaction(async () => {
      await database.prepare(`UPDATE program_template_workouts SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ? AND template_id = ?`).run(...values, targetWorkout.template_workout_id, program.template_id);
      await database.prepare(`UPDATE workouts SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE template_workout_id = ?`).run(...values, targetWorkout.template_workout_id);
    });
    await updateSharedWorkout();
  } else await database.prepare(`UPDATE workouts SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ? AND program_id = ? AND athlete_id = ?`).run(...values, workout.id, program.id, program.athlete_id);
  response.json({ message: 'Scheduled workout updated.' });
});

registerRoute('delete', '/api/programs/:programId/workouts/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const program = await getProgram(request.params.programId);
  if (!program || !canManageProgram(user, program)) return response.status(403).json({ message: 'You cannot delete workouts from this program.' });
  if (program.template_id) {
    const workout = await database.prepare('SELECT * FROM workouts WHERE id = ? AND assignment_id = ?').get(request.params.id, program.assignment_id);
    if (!workout) return response.status(404).json({ message: 'Scheduled workout not found.' });
    const deleteSharedWorkout = database.transaction(async () => {
      await database.prepare('DELETE FROM program_template_workouts WHERE id = ? AND template_id = ?').run(workout.template_workout_id, program.template_id);
      await database.prepare('DELETE FROM workouts WHERE template_workout_id = ?').run(workout.template_workout_id);
    });
    await deleteSharedWorkout();
    return response.json({ message: 'Scheduled workout deleted.' });
  }
  const result = await database.prepare('DELETE FROM workouts WHERE id = ? AND program_id = ? AND athlete_id = ?').run(request.params.id, program.id, program.athlete_id);
  if (!result.changes) return response.status(404).json({ message: 'Scheduled workout not found.' });
  response.json({ message: 'Scheduled workout deleted.' });
});

registerRoute('put', '/api/workouts/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  if (!validCompleted(request.body.completed)) return response.status(400).json({ message: 'Completed must be true or false.' });
  const result = await database.prepare('UPDATE workouts SET completed = ? WHERE id = ? AND athlete_id = ?').run(request.body.completed === true || request.body.completed === 1 || request.body.completed === '1' ? 1 : 0, request.params.id, user.id);
  if (!result.changes) return response.status(404).json({ message: 'Workout not found.' });
  response.json({ message: 'Workout status updated.' });
});
registerRoute('delete', '/api/workouts/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const workout = await database.prepare('SELECT * FROM workouts WHERE id = ? AND athlete_id = ?').get(request.params.id, user.id);
  if (!workout) return response.status(404).json({ message: 'Workout not found.' });
  const program = workout.assignment_id ? await getProgram(`shared-${workout.assignment_id}`) : workout.program_id ? await getProgram(workout.program_id) : null;
  if (program && !canManageProgram(user, program)) return response.status(403).json({ message: 'You cannot delete this scheduled workout.' });
  const result = await database.prepare('DELETE FROM workouts WHERE id = ? AND athlete_id = ?').run(request.params.id, user.id);
  if (!result.changes) return response.status(404).json({ message: 'Workout not found.' });
  response.json({ message: 'Workout deleted.' });
});

registerRoute('get', '/api/coaches', requireLogin, async (request, response) => response.json({ coaches: await database.prepare("SELECT id, name, email FROM users WHERE role = 'coach' AND id != ? ORDER BY name").all((await getUser(request)).id) }));
registerRoute('post', '/api/coach-requests', requireLogin, async (request, response) => {
  const user = await getUser(request);
  if (user.role !== 'athlete') return response.status(403).json({ message: 'Only athletes can request a coach.' });
  try { await database.prepare('INSERT INTO coach_requests (athlete_id, coach_id, message) VALUES (?, ?, ?)').run(user.id, request.body.coach_id, request.body.message || 'I would like to connect for training support.'); response.status(201).json({ message: 'Coach request sent.' }); } catch (error) { response.status(409).json({ message: 'You already sent a request to this coach.' }); }
});
registerRoute('get', '/api/coach-requests', requireLogin, async (request, response) => {
  const user = await getUser(request);
  const condition = user.role === 'coach' ? 'r.coach_id = ?' : 'r.athlete_id = ?';
  response.json({ requests: await database.prepare(`SELECT r.*, a.name athlete_name, a.email athlete_email, c.name coach_name, c.email coach_email FROM coach_requests r JOIN users a ON a.id = r.athlete_id JOIN users c ON c.id = r.coach_id WHERE ${condition} ORDER BY r.created_at DESC`).all(user.id) });
});
registerRoute('put', '/api/coach-requests/:id', requireLogin, async (request, response) => {
  const user = await getUser(request);
  if (user.role !== 'coach' || !['accepted', 'rejected'].includes(request.body.status)) return response.status(403).json({ message: 'Only coaches can update requests.' });
  const result = await database.prepare('UPDATE coach_requests SET status = ? WHERE id = ? AND coach_id = ?').run(request.body.status, request.params.id, user.id);
  if (!result.changes) return response.status(404).json({ message: 'Request not found.' });
  response.json({ message: `Request ${request.body.status}.` });
});

registerRoute('get', '/api/athletes', requireLogin, async (request, response) => {
  const user = await getUser(request);
  if (user.role !== 'coach') return response.status(403).json({ message: 'Only coaches can view athletes.' });
  const athletes = await database.prepare("SELECT u.id, u.name, u.email, COALESCE((SELECT pt.name FROM program_assignments pa JOIN program_templates pt ON pt.id = pa.template_id WHERE pa.athlete_id = u.id AND pt.coach_id = r.coach_id ORDER BY pa.assigned_at DESC LIMIT 1), (SELECT name FROM programs WHERE athlete_id = u.id AND coach_id = r.coach_id ORDER BY created_at DESC LIMIT 1)) current_program, (SELECT COUNT(*) FROM workouts WHERE athlete_id = u.id) workout_count FROM users u JOIN coach_requests r ON r.athlete_id = u.id WHERE r.coach_id = ? AND r.status = 'accepted' ORDER BY u.name").all(user.id);
  response.json({ athletes });
});

// style.css lives at the project root, while app.js is served from public/.
app.get('/style.css', (request, response) => response.sendFile(path.join(__dirname, 'style.css')));

// Keep unknown API requests as JSON instead of sending the SPA document.
app.use('/api', (request, response) => response.status(404).json({ message: 'API route not found.' }));

app.get('*', (request, response) => response.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, request, response, next) => {
  console.error('Request failed:', error);
  if (response.headersSent) return next(error);
  response.status(500).json({ message: 'An unexpected server error occurred.' });
});

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`TRIDAVO server running on port ${port}`);
  });
}

module.exports = app;
