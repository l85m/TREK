/**
 * Unit tests for the new MCP tool surface: todos, weather, notifications, and
 * reservation file links. Covers happy paths, access control, demo-mode denial
 * for writes, and real-time broadcasts where applicable.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock, broadcastToUserMock, fetchMock } = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
  broadcastToUserMock: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock('../../../src/websocket', () => ({
  broadcast: broadcastMock,
  broadcastToUser: broadcastToUserMock,
}));

// Stub global fetch for weather (Open-Meteo)
const originalFetch = globalThis.fetch;
beforeAll(() => { (globalThis as any).fetch = fetchMock; });
afterAll(() => { (globalThis as any).fetch = originalFetch; });

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, createReservation } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  broadcastToUserMock.mockClear();
  fetchMock.mockReset();
  delete process.env.DEMO_MODE;
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

describe('Tool: create_todo', () => {
  it('creates a todo with all fields', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'create_todo',
        arguments: { tripId: trip.id, name: 'Book flight', category: 'Travel', due_date: '2027-04-01', priority: 1 },
      });
      const data = parseToolResult(result) as any;
      expect(data.item.name).toBe('Book flight');
      expect(data.item.category).toBe('Travel');
      expect(data.item.due_date).toBe('2027-04-01');
      expect(data.item.priority).toBe(1);
      expect(data.item.checked).toBe(0);
    });
  });

  it('broadcasts todo:created', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:created', expect.any(Object));
    });
  });

  it('denies access for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });

  it('is denied in demo mode', async () => {
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    process.env.DEMO_MODE = 'true';
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Tool: list_todos', () => {
  it('lists todos in sort order', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'First' } });
      await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'Second' } });
      const result = await h.client.callTool({ name: 'list_todos', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(2);
      expect(data.items[0].name).toBe('First');
      expect(data.items[1].name).toBe('Second');
    });
  });
});

describe('Tool: toggle_todo', () => {
  it('toggles checked on and off', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(
        await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'X' } })
      ) as any;
      const toggled = parseToolResult(
        await h.client.callTool({ name: 'toggle_todo', arguments: { tripId: trip.id, todoId: created.item.id, checked: true } })
      ) as any;
      expect(toggled.item.checked).toBe(1);
    });
  });
});

describe('Tool: update_todo', () => {
  it('updates name and priority', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(
        await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'Old' } })
      ) as any;
      const updated = parseToolResult(
        await h.client.callTool({
          name: 'update_todo',
          arguments: { tripId: trip.id, todoId: created.item.id, name: 'New', priority: 2 },
        })
      ) as any;
      expect(updated.item.name).toBe('New');
      expect(updated.item.priority).toBe(2);
    });
  });
});

describe('Tool: delete_todo', () => {
  it('deletes a todo and broadcasts', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const created = parseToolResult(
        await h.client.callTool({ name: 'create_todo', arguments: { tripId: trip.id, name: 'Delete me' } })
      ) as any;
      await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, todoId: created.item.id } });
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'todo:deleted', expect.objectContaining({ itemId: created.item.id }));
      expect(testDb.prepare('SELECT id FROM todo_items WHERE id = ?').get(created.item.id)).toBeUndefined();
    });
  });

  it('errors on missing todo', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_todo', arguments: { tripId: trip.id, todoId: 99999 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

describe('Tool: get_weather', () => {
  it('returns summary weather for current conditions', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ current: { temperature_2m: 17.4, weathercode: 0 } }),
    });
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_weather', arguments: { lat: 48.2, lng: 16.37 } });
      const data = parseToolResult(result) as any;
      expect(data.temp).toBe(17);
      expect(data.main).toBe('Clear');
      expect(data.type).toBe('current');
    });
  });

  it('returns an error result on upstream failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: true, reason: 'upstream' }) });
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_weather', arguments: { lat: 0, lng: 0 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function insertNotification(userId: number, overrides: Partial<{ type: string; is_read: number }> = {}) {
  const result = testDb.prepare(`
    INSERT INTO notifications (type, scope, target, sender_id, recipient_id, title_key, title_params, text_key, text_params, is_read)
    VALUES (?, 'user', ?, NULL, ?, 'title.key', '{}', 'text.key', '{}', ?)
  `).run(overrides.type ?? 'simple', userId, userId, overrides.is_read ?? 0);
  return result.lastInsertRowid as number;
}

describe('Tool: list_notifications', () => {
  it('lists notifications with total and unread count', async () => {
    const { user } = createUser(testDb);
    insertNotification(user.id, { is_read: 0 });
    insertNotification(user.id, { is_read: 1 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.total).toBe(2);
      expect(data.unread_count).toBe(1);
      expect(data.notifications).toHaveLength(2);
    });
  });

  it('respects unreadOnly filter', async () => {
    const { user } = createUser(testDb);
    insertNotification(user.id, { is_read: 0 });
    insertNotification(user.id, { is_read: 1 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: { unreadOnly: true } });
      const data = parseToolResult(result) as any;
      expect(data.notifications).toHaveLength(1);
      expect(data.notifications[0].is_read).toBe(0);
    });
  });

  it('does not expose notifications belonging to other users', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    insertNotification(other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_notifications', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.total).toBe(0);
    });
  });
});

describe('Tool: get_unread_notification_count', () => {
  it('returns only this user\'s unread count', async () => {
    const { user } = createUser(testDb);
    insertNotification(user.id, { is_read: 0 });
    insertNotification(user.id, { is_read: 0 });
    insertNotification(user.id, { is_read: 1 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_unread_notification_count', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.unread_count).toBe(2);
    });
  });
});

describe('Tool: mark_notification_read', () => {
  it('marks a notification as read', async () => {
    const { user } = createUser(testDb);
    const nid = insertNotification(user.id, { is_read: 0 });
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'mark_notification_read', arguments: { notificationId: nid } });
      const row = testDb.prepare('SELECT is_read FROM notifications WHERE id = ?').get(nid) as any;
      expect(row.is_read).toBe(1);
    });
  });

  it('errors when the notification belongs to a different user', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const nid = insertNotification(other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'mark_notification_read', arguments: { notificationId: nid } });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Tool: mark_all_notifications_read', () => {
  it('marks every unread notification for this user as read', async () => {
    const { user } = createUser(testDb);
    insertNotification(user.id, { is_read: 0 });
    insertNotification(user.id, { is_read: 0 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'mark_all_notifications_read', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.marked_read).toBe(2);
    });
  });
});

describe('Tool: delete_notification', () => {
  it('deletes the notification', async () => {
    const { user } = createUser(testDb);
    const nid = insertNotification(user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({ name: 'delete_notification', arguments: { notificationId: nid } });
      expect(testDb.prepare('SELECT id FROM notifications WHERE id = ?').get(nid)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Reservation file links
// ---------------------------------------------------------------------------

function insertFile(tripId: number, userId: number) {
  const result = testDb.prepare(`
    INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by)
    VALUES (?, 'uuid.pdf', 'boarding-pass.pdf', 1024, 'application/pdf', ?)
  `).run(tripId, userId);
  return result.lastInsertRowid as number;
}

describe('Tool: link_file_to_reservation', () => {
  it('creates a file_link row and broadcasts file:updated', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const reservation = createReservation(testDb, trip.id);
    const fileId = insertFile(trip.id, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'link_file_to_reservation',
        arguments: { tripId: trip.id, fileId, reservationId: reservation.id },
      });
      const row = testDb.prepare('SELECT * FROM file_links WHERE file_id = ? AND reservation_id = ?').get(fileId, reservation.id);
      expect(row).toBeDefined();
      expect(broadcastMock).toHaveBeenCalledWith(trip.id, 'file:updated', expect.objectContaining({ fileId }));
    });
  });

  it('errors when the reservation is not in this trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const otherTrip = createTrip(testDb, user.id);
    const reservation = createReservation(testDb, otherTrip.id);
    const fileId = insertFile(trip.id, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'link_file_to_reservation',
        arguments: { tripId: trip.id, fileId, reservationId: reservation.id },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('denies access for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    const reservation = createReservation(testDb, trip.id);
    const fileId = insertFile(trip.id, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'link_file_to_reservation',
        arguments: { tripId: trip.id, fileId, reservationId: reservation.id },
      });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Tool: list_reservation_files', () => {
  it('returns files with the link_id needed for unlinking', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const reservation = createReservation(testDb, trip.id);
    const fileId = insertFile(trip.id, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'link_file_to_reservation',
        arguments: { tripId: trip.id, fileId, reservationId: reservation.id },
      });
      const result = await h.client.callTool({
        name: 'list_reservation_files',
        arguments: { tripId: trip.id, reservationId: reservation.id },
      });
      const data = parseToolResult(result) as any;
      expect(data.files).toHaveLength(1);
      expect(data.files[0].id).toBe(fileId);
      expect(data.files[0].link_id).toBeTruthy();
    });
  });
});

describe('Tool: unlink_file_from_reservation', () => {
  it('removes the link_row but leaves the file intact', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const reservation = createReservation(testDb, trip.id);
    const fileId = insertFile(trip.id, user.id);
    await withHarness(user.id, async (h) => {
      await h.client.callTool({
        name: 'link_file_to_reservation',
        arguments: { tripId: trip.id, fileId, reservationId: reservation.id },
      });
      const link = testDb.prepare('SELECT id FROM file_links WHERE file_id = ? AND reservation_id = ?').get(fileId, reservation.id) as { id: number };
      await h.client.callTool({
        name: 'unlink_file_from_reservation',
        arguments: { tripId: trip.id, fileId, linkId: link.id },
      });
      expect(testDb.prepare('SELECT id FROM file_links WHERE id = ?').get(link.id)).toBeUndefined();
      expect(testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(fileId)).toBeDefined();
    });
  });
});
