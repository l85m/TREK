const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, canAccessTrip, isOwner } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const router = express.Router();

const coversDir = path.join(__dirname, '../../uploads/covers');
const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
    cb(null, coversDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (file.mimetype.startsWith('image/') && !file.mimetype.includes('svg') && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, png, gif, webp images allowed'));
    }
  },
});

const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

function generateDays(tripId, startDate, endDate) {
  db.prepare('DELETE FROM days WHERE trip_id = ?').run(tripId);
  if (!startDate || !endDate) {
    const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, NULL)');
    for (let i = 1; i <= 7; i++) insert.run(tripId, i);
    return;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  const numDays = Math.min(Math.floor((end - start) / 86400000) + 1, 90);
  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    insert.run(tripId, i + 1, d.toISOString().split('T')[0]);
  }
}

// GET /api/trips — active or archived, includes shared trips
router.get('/', authenticate, (req, res) => {
  const archived = req.query.archived === '1' ? 1 : 0;
  const userId = req.user.id;
  const trips = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = :archived
    ORDER BY t.created_at DESC
  `).all({ userId, archived });
  res.json({ trips });
});

// POST /api/trips
router.post('/', authenticate, (req, res) => {
  const { title, description, start_date, end_date, currency } = req.body;
  if (!title) return res.status(400).json({ error: 'Titel ist erforderlich' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'Enddatum muss nach dem Startdatum liegen' });

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, title, description || null, start_date || null, end_date || null, currency || 'EUR');

  const tripId = result.lastInsertRowid;
  generateDays(tripId, start_date, end_date);
  const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: req.user.id, tripId });
  res.status(201).json({ trip });
});

// GET /api/trips/:id
router.get('/:id', authenticate, (req, res) => {
  const userId = req.user.id;
  const trip = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
  `).get({ userId, tripId: req.params.id });
  if (!trip) return res.status(404).json({ error: 'Reise nicht gefunden' });
  res.json({ trip });
});

// PUT /api/trips/:id — all members can edit; archive/cover owner-only
router.put('/:id', authenticate, (req, res) => {
  const access = canAccessTrip(req.params.id, req.user.id);
  if (!access) return res.status(404).json({ error: 'Reise nicht gefunden' });

  const ownerOnly = req.body.is_archived !== undefined || req.body.cover_image !== undefined;
  if (ownerOnly && !isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Nur der Eigentümer kann diese Einstellung ändern' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  const { title, description, start_date, end_date, currency, is_archived, cover_image } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'Enddatum muss nach dem Startdatum liegen' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, req.params.id);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: req.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id']);
});

// POST /api/trips/:id/cover
router.post('/:id/cover', authenticate, demoUploadBlock, uploadCover.single('cover'), (req, res) => {
  if (!isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Nur der Eigentümer kann das Titelbild ändern' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Reise nicht gefunden' });
  if (!req.file) return res.status(400).json({ error: 'Kein Bild hochgeladen' });

  if (trip.cover_image) {
    const oldPath = path.join(__dirname, '../../', trip.cover_image.replace(/^\//, ''));
    const resolvedPath = path.resolve(oldPath);
    const uploadsDir = path.resolve(__dirname, '../../uploads');
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  }

  const coverUrl = `/uploads/covers/${req.file.filename}`;
  db.prepare('UPDATE trips SET cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(coverUrl, req.params.id);
  res.json({ cover_image: coverUrl });
});

// DELETE /api/trips/:id — owner only
router.delete('/:id', authenticate, (req, res) => {
  if (!isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Nur der Eigentümer kann die Reise löschen' });
  const deletedTripId = Number(req.params.id);
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
  broadcast(deletedTripId, 'trip:deleted', { id: deletedTripId }, req.headers['x-socket-id']);
});

// ── Member Management ────────────────────────────────────────────────────────

// GET /api/trips/:id/members
router.get('/:id/members', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Reise nicht gefunden' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id);
  const members = db.prepare(`
    SELECT u.id, u.username, u.email, u.avatar,
      CASE WHEN u.id = ? THEN 'owner' ELSE 'member' END as role,
      m.added_at,
      ib.username as invited_by_username
    FROM trip_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users ib ON ib.id = m.invited_by
    WHERE m.trip_id = ?
    ORDER BY m.added_at ASC
  `).all(trip.user_id, req.params.id);

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(trip.user_id);

  res.json({
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
    current_user_id: req.user.id,
  });
});

// POST /api/trips/:id/members — add by email or username
router.post('/:id/members', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Reise nicht gefunden' });

  const { identifier } = req.body; // email or username
  if (!identifier) return res.status(400).json({ error: 'E-Mail oder Benutzername erforderlich' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim());

  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id);
  if (target.id === trip.user_id)
    return res.status(400).json({ error: 'Der Eigentümer der Reise ist bereits Mitglied' });

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(req.params.id, target.id);
  if (existing) return res.status(400).json({ error: 'Benutzer hat bereits Zugriff' });

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(req.params.id, target.id, req.user.id);

  res.status(201).json({ member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null } });
});

// DELETE /api/trips/:id/members/:userId — owner removes anyone; member removes self
router.delete('/:id/members/:userId', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Reise nicht gefunden' });

  const targetId = parseInt(req.params.userId);
  const isSelf = targetId === req.user.id;
  if (!isSelf && !isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Keine Berechtigung' });

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

module.exports = router;
