const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, canAccessTrip } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const router = express.Router({ mergeParams: true });

const filesDir = path.join(__dirname, '../../uploads/files');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
    cb(null, filesDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const blockedExts = ['.svg', '.html', '.htm', '.xml'];
    if (blockedExts.includes(ext) || file.mimetype.includes('svg')) {
      return cb(new Error('File type not allowed'));
    }
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Dateityp nicht erlaubt'));
    }
  },
});

function verifyTripOwnership(tripId, userId) {
  return canAccessTrip(tripId, userId);
}

function formatFile(file) {
  return {
    ...file,
    url: `/uploads/files/${file.filename}`,
  };
}

// GET /api/trips/:tripId/files
router.get('/', authenticate, (req, res) => {
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Reise nicht gefunden' });

  const files = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.trip_id = ?
    ORDER BY f.created_at DESC
  `).all(tripId);
  res.json({ files: files.map(formatFile) });
});

// POST /api/trips/:tripId/files
router.post('/', authenticate, demoUploadBlock, upload.single('file'), (req, res) => {
  const { tripId } = req.params;
  const { place_id, description, reservation_id } = req.body;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Reise nicht gefunden' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  }

  const result = db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    place_id || null,
    reservation_id || null,
    req.file.filename,
    req.file.originalname,
    req.file.size,
    req.file.mimetype,
    description || null
  );

  const file = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json({ file: formatFile(file) });
  broadcast(tripId, 'file:created', { file: formatFile(file) }, req.headers['x-socket-id']);
});

// PUT /api/trips/:tripId/files/:id
router.put('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { description, place_id, reservation_id } = req.body;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Reise nicht gefunden' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });

  db.prepare(`
    UPDATE trip_files SET
      description = COALESCE(?, description),
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(
    description !== undefined ? description : file.description,
    place_id !== undefined ? (place_id || null) : file.place_id,
    reservation_id !== undefined ? (reservation_id || null) : file.reservation_id,
    id
  );

  const updated = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.id = ?
  `).get(id);
  res.json({ file: formatFile(updated) });
  broadcast(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id']);
});

// DELETE /api/trips/:tripId/files/:id
router.delete('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Reise nicht gefunden' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });

  const filePath = path.join(filesDir, file.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error('Error deleting file:', e); }
  }

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id']);
});

module.exports = router;
