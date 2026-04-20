import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../db/database';
import { broadcast } from '../websocket';
import { isDemoUser } from '../services/authService';
import {
  listTrips, createTrip, updateTrip, deleteTrip, getTripSummary,
  isOwner, verifyTripAccess,
} from '../services/tripService';
import { listPlaces, createPlace, updatePlace, deletePlace } from '../services/placeService';
import { listCategories } from '../services/categoryService';
import {
  dayExists, placeExists, createAssignment, assignmentExistsInDay,
  deleteAssignment, reorderAssignments, getAssignmentForTrip, updateTime,
} from '../services/assignmentService';
import { createBudgetItem, updateBudgetItem, deleteBudgetItem } from '../services/budgetService';
import { createItem as createPackingItem, updateItem as updatePackingItem, deleteItem as deletePackingItem } from '../services/packingService';
import { createReservation, getReservation, updateReservation, deleteReservation } from '../services/reservationService';
import { getDay, updateDay, validateAccommodationRefs } from '../services/dayService';
import { createNote as createDayNote, getNote as getDayNote, updateNote as updateDayNote, deleteNote as deleteDayNote, dayExists as dayNoteExists } from '../services/dayNoteService';
import { createNote as createCollabNote, updateNote as updateCollabNote, deleteNote as deleteCollabNote } from '../services/collabService';
import {
  markCountryVisited, unmarkCountryVisited, createBucketItem, deleteBucketItem,
} from '../services/atlasService';
import { searchPlaces } from '../services/mapsService';
import {
  listItems as listTodoItems,
  createItem as createTodoItem,
  updateItem as updateTodoItem,
  deleteItem as deleteTodoItem,
} from '../services/todoService';
import { getWeather, getDetailedWeather } from '../services/weatherService';
import {
  getNotifications,
  getUnreadCount,
  markRead as markNotificationRead,
  markAllRead as markAllNotificationsRead,
  deleteNotification,
  respondToBoolean as respondToNotification,
} from '../services/inAppNotifications';
import {
  listFiles,
  getFileById,
  createFileLink,
  deleteFileLink,
  getFileLinks,
} from '../services/fileService';

const MAX_MCP_TRIP_DAYS = 90;

function demoDenied() {
  return { content: [{ type: 'text' as const, text: 'Write operations are disabled in demo mode.' }], isError: true };
}

function noAccess() {
  return { content: [{ type: 'text' as const, text: 'Trip not found or access denied.' }], isError: true };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer, userId: number): void {
  // --- TRIPS ---

  server.registerTool(
    'create_trip',
    {
      description: 'Create a new trip. Returns the created trip with its generated days.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Trip title'),
        description: z.string().max(2000).optional().describe('Trip description'),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date (YYYY-MM-DD)'),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date (YYYY-MM-DD)'),
        currency: z.string().length(3).optional().describe('Currency code (e.g. EUR, USD)'),
      },
    },
    async ({ title, description, start_date, end_date, currency }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (start_date) {
        const d = new Date(start_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start_date)
          return { content: [{ type: 'text' as const, text: 'start_date is not a valid calendar date.' }], isError: true };
      }
      if (end_date) {
        const d = new Date(end_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== end_date)
          return { content: [{ type: 'text' as const, text: 'end_date is not a valid calendar date.' }], isError: true };
      }
      if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
        return { content: [{ type: 'text' as const, text: 'End date must be after start date.' }], isError: true };
      }
      const { trip } = createTrip(userId, { title, description, start_date, end_date, currency }, MAX_MCP_TRIP_DAYS);
      return ok({ trip });
    }
  );

  server.registerTool(
    'update_trip',
    {
      description: 'Update an existing trip\'s details.',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        currency: z.string().length(3).optional(),
      },
    },
    async ({ tripId, title, description, start_date, end_date, currency }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (start_date) {
        const d = new Date(start_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start_date)
          return { content: [{ type: 'text' as const, text: 'start_date is not a valid calendar date.' }], isError: true };
      }
      if (end_date) {
        const d = new Date(end_date + 'T00:00:00Z');
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== end_date)
          return { content: [{ type: 'text' as const, text: 'end_date is not a valid calendar date.' }], isError: true };
      }
      const { updatedTrip } = updateTrip(tripId, userId, { title, description, start_date, end_date, currency }, 'user');
      broadcast(tripId, 'trip:updated', { trip: updatedTrip });
      return ok({ trip: updatedTrip });
    }
  );

  server.registerTool(
    'delete_trip',
    {
      description: 'Delete a trip. Only the trip owner can delete it.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
    },
    async ({ tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!isOwner(tripId, userId)) return noAccess();
      deleteTrip(tripId, userId, 'user');
      return ok({ success: true, tripId });
    }
  );

  server.registerTool(
    'list_trips',
    {
      description: 'List all trips the current user owns or is a member of. Use this for trip discovery before calling get_trip_summary.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived trips (default false)'),
      },
    },
    async ({ include_archived }) => {
      const trips = listTrips(userId, include_archived ? null : 0);
      return ok({ trips });
    }
  );

  // --- PLACES ---

  server.registerTool(
    'create_place',
    {
      description: 'Add a new place/POI to a trip. Set google_place_id or osm_id (from search_place) so the app can show opening hours and ratings.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(500).optional(),
        category_id: z.number().int().positive().optional().describe('Category ID — use list_categories to see available options'),
        google_place_id: z.string().optional().describe('Google Place ID from search_place — enables opening hours display'),
        osm_id: z.string().optional().describe('OpenStreetMap ID from search_place (e.g. "way:12345") — enables opening hours if no Google ID'),
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
      },
    },
    async ({ tripId, name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = createPlace(String(tripId), { name, description, lat, lng, address, category_id, google_place_id, osm_id, notes, website, phone });
      broadcast(tripId, 'place:created', { place });
      return ok({ place });
    }
  );

  server.registerTool(
    'update_place',
    {
      description: 'Update an existing place in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        placeId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(500).optional(),
        notes: z.string().max(2000).optional(),
        website: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
      },
    },
    async ({ tripId, placeId, name, description, lat, lng, address, notes, website, phone }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const place = updatePlace(String(tripId), String(placeId), { name, description, lat, lng, address, notes, website, phone });
      if (!place) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      broadcast(tripId, 'place:updated', { place });
      return ok({ place });
    }
  );

  server.registerTool(
    'delete_place',
    {
      description: 'Delete a place from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        placeId: z.number().int().positive(),
      },
    },
    async ({ tripId, placeId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePlace(String(tripId), String(placeId));
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      broadcast(tripId, 'place:deleted', { placeId });
      return ok({ success: true });
    }
  );

  // --- CATEGORIES ---

  server.registerTool(
    'list_categories',
    {
      description: 'List all available place categories with their id, name, icon and color. Use category_id when creating or updating places.',
      inputSchema: {},
    },
    async () => {
      const categories = listCategories();
      return ok({ categories });
    }
  );

  // --- SEARCH ---

  server.registerTool(
    'search_place',
    {
      description: 'Search for a real-world place by name or address. Returns results with osm_id (and google_place_id if configured). Use these IDs when calling create_place so the app can display opening hours and ratings.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Place name or address to search for'),
      },
    },
    async ({ query }) => {
      try {
        const result = await searchPlaces(userId, query);
        return ok(result);
      } catch {
        return { content: [{ type: 'text' as const, text: 'Place search failed.' }], isError: true };
      }
    }
  );

  // --- ASSIGNMENTS ---

  server.registerTool(
    'assign_place_to_day',
    {
      description: 'Assign a place to a specific day in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        placeId: z.number().int().positive(),
        notes: z.string().max(500).optional(),
      },
    },
    async ({ tripId, dayId, placeId, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!dayExists(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      if (!placeExists(placeId, tripId)) return { content: [{ type: 'text' as const, text: 'Place not found.' }], isError: true };
      const assignment = createAssignment(dayId, placeId, notes || null);
      broadcast(tripId, 'assignment:created', { assignment });
      return ok({ assignment });
    }
  );

  server.registerTool(
    'unassign_place',
    {
      description: 'Remove a place assignment from a day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
      },
    },
    async ({ tripId, dayId, assignmentId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!assignmentExistsInDay(assignmentId, dayId, tripId))
        return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      deleteAssignment(assignmentId);
      broadcast(tripId, 'assignment:deleted', { assignmentId, dayId });
      return ok({ success: true });
    }
  );

  // --- BUDGET ---

  server.registerTool(
    'create_budget_item',
    {
      description: 'Add a budget/expense item to a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Budget category (e.g. Accommodation, Food, Transport)'),
        total_price: z.number().nonnegative(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ tripId, name, category, total_price, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createBudgetItem(tripId, { category, name, total_price, note });
      broadcast(tripId, 'budget:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_budget_item',
    {
      description: 'Delete a budget item from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deleteBudgetItem(itemId, tripId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      broadcast(tripId, 'budget:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- PACKING ---

  server.registerTool(
    'create_packing_item',
    {
      description: 'Add an item to the packing checklist for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Packing category (e.g. Clothes, Electronics)'),
      },
    },
    async ({ tripId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createPackingItem(tripId, { name, category: category || 'General' });
      broadcast(tripId, 'packing:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'toggle_packing_item',
    {
      description: 'Check or uncheck a packing item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        checked: z.boolean(),
      },
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updatePackingItem(tripId, itemId, { checked: checked ? 1 : 0 }, ['checked']);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      broadcast(tripId, 'packing:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_packing_item',
    {
      description: 'Remove an item from the packing checklist.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePackingItem(tripId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      broadcast(tripId, 'packing:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- RESERVATIONS ---

  server.registerTool(
    'create_reservation',
    {
      description: 'Recommend a reservation for a trip. Created as pending — the user must confirm it. Linking: hotel → use place_id + start_day_id + end_day_id (all three required to create the accommodation link); restaurant/train/car/cruise/event/tour/activity/other → use assignment_id; flight → no linking.',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200),
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        day_id: z.number().int().positive().optional(),
        place_id: z.number().int().positive().optional().describe('Hotel place to link (hotel type only)'),
        start_day_id: z.number().int().positive().optional().describe('Check-in day (hotel type only; requires place_id and end_day_id)'),
        end_day_id: z.number().int().positive().optional().describe('Check-out day (hotel type only; requires place_id and start_day_id)'),
        check_in: z.string().max(10).optional().describe('Check-in time (e.g. "15:00", hotel type only)'),
        check_out: z.string().max(10).optional().describe('Check-out time (e.g. "11:00", hotel type only)'),
        assignment_id: z.number().int().positive().optional().describe('Link to a day assignment (restaurant, train, car, cruise, event, tour, activity, other)'),
      },
    },
    async ({ tripId, title, type, reservation_time, location, confirmation_number, notes, day_id, place_id, start_day_id, end_day_id, check_in, check_out, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();

      // Validate that all referenced IDs belong to this trip
      if (day_id && !getDay(day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'day_id does not belong to this trip.' }], isError: true };
      if (place_id && !placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (start_day_id && !getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (end_day_id && !getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };
      if (assignment_id && !getAssignmentForTrip(assignment_id, tripId))
        return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };

      const createAccommodation = (type === 'hotel' && place_id && start_day_id && end_day_id)
        ? { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined, confirmation: confirmation_number || undefined }
        : undefined;

      const { reservation, accommodationCreated } = createReservation(tripId, {
        title, type, reservation_time, location, confirmation_number,
        notes, day_id, place_id, assignment_id,
        create_accommodation: createAccommodation,
      });

      if (accommodationCreated) {
        broadcast(tripId, 'accommodation:created', {});
      }
      broadcast(tripId, 'reservation:created', { reservation });
      return ok({ reservation });
    }
  );

  server.registerTool(
    'delete_reservation',
    {
      description: 'Delete a reservation from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
      },
    },
    async ({ tripId, reservationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const { deleted, accommodationDeleted } = deleteReservation(reservationId, tripId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      if (accommodationDeleted) {
        broadcast(tripId, 'accommodation:deleted', { accommodationId: deleted.accommodation_id });
      }
      broadcast(tripId, 'reservation:deleted', { reservationId });
      return ok({ success: true });
    }
  );

  server.registerTool(
    'link_hotel_accommodation',
    {
      description: 'Set or update the check-in/check-out day links for a hotel reservation. Creates or updates the accommodation record that ties the reservation to a place and a date range. Use the day IDs from get_trip_summary.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
        place_id: z.number().int().positive().describe('The hotel place to link'),
        start_day_id: z.number().int().positive().describe('Check-in day ID'),
        end_day_id: z.number().int().positive().describe('Check-out day ID'),
        check_in: z.string().max(10).optional().describe('Check-in time (e.g. "15:00")'),
        check_out: z.string().max(10).optional().describe('Check-out time (e.g. "11:00")'),
      },
    },
    async ({ tripId, reservationId, place_id, start_day_id, end_day_id, check_in, check_out }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const current = getReservation(reservationId, tripId);
      if (!current) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      if (current.type !== 'hotel') return { content: [{ type: 'text' as const, text: 'Reservation is not of type hotel.' }], isError: true };

      if (!placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (!getDay(start_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'start_day_id does not belong to this trip.' }], isError: true };
      if (!getDay(end_day_id, tripId))
        return { content: [{ type: 'text' as const, text: 'end_day_id does not belong to this trip.' }], isError: true };

      const isNewAccommodation = !current.accommodation_id;
      const { reservation } = updateReservation(reservationId, tripId, {
        place_id,
        type: current.type,
        status: current.status as string,
        create_accommodation: { place_id, start_day_id, end_day_id, check_in: check_in || undefined, check_out: check_out || undefined },
      }, current);

      broadcast(tripId, isNewAccommodation ? 'accommodation:created' : 'accommodation:updated', {});
      broadcast(tripId, 'reservation:updated', { reservation });
      return ok({ reservation, accommodation_id: (reservation as any).accommodation_id });
    }
  );

  // --- DAYS ---

  server.registerTool(
    'update_assignment_time',
    {
      description: 'Set the start and/or end time for a place assignment on a day (e.g. "09:00", "11:30"). Pass null to clear a time.',
      inputSchema: {
        tripId: z.number().int().positive(),
        assignmentId: z.number().int().positive(),
        place_time: z.string().max(50).nullable().optional().describe('Start time (e.g. "09:00"), or null to clear'),
        end_time: z.string().max(50).nullable().optional().describe('End time (e.g. "11:00"), or null to clear'),
      },
    },
    async ({ tripId, assignmentId, place_time, end_time }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getAssignmentForTrip(assignmentId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Assignment not found.' }], isError: true };
      const assignment = updateTime(
        assignmentId,
        place_time !== undefined ? place_time : (existing as any).assignment_time,
        end_time !== undefined ? end_time : (existing as any).assignment_end_time
      );
      broadcast(tripId, 'assignment:updated', { assignment });
      return ok({ assignment });
    }
  );

  server.registerTool(
    'update_day',
    {
      description: 'Set the title of a day in a trip (e.g. "Arrival in Paris", "Free day").',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        title: z.string().max(200).nullable().describe('Day title, or null to clear it'),
      },
    },
    async ({ tripId, dayId, title }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const current = getDay(dayId, tripId);
      if (!current) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const updated = updateDay(dayId, current, title !== undefined ? { title } : {});
      broadcast(tripId, 'day:updated', { day: updated });
      return ok({ day: updated });
    }
  );

  // --- RESERVATIONS (update) ---

  server.registerTool(
    'update_reservation',
    {
      description: 'Update an existing reservation in a trip. Use status "confirmed" to confirm a pending recommendation, or "pending" to revert it. Linking: hotel → use place_id to link to an accommodation place; restaurant/train/car/cruise/event/tour/activity/other → use assignment_id to link to a day assignment; flight → no linking.',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        type: z.enum(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'activity', 'other']).optional(),
        reservation_time: z.string().optional().describe('ISO 8601 datetime or time string'),
        location: z.string().max(500).optional(),
        confirmation_number: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        status: z.enum(['pending', 'confirmed', 'cancelled']).optional(),
        place_id: z.number().int().positive().nullable().optional().describe('Link to a place (use for hotel type), or null to unlink'),
        assignment_id: z.number().int().positive().nullable().optional().describe('Link to a day assignment (use for restaurant, train, car, cruise, event, tour, activity, other), or null to unlink'),
      },
    },
    async ({ tripId, reservationId, title, type, reservation_time, location, confirmation_number, notes, status, place_id, assignment_id }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getReservation(reservationId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };

      if (place_id != null && !placeExists(place_id, tripId))
        return { content: [{ type: 'text' as const, text: 'place_id does not belong to this trip.' }], isError: true };
      if (assignment_id != null && !getAssignmentForTrip(assignment_id, tripId))
        return { content: [{ type: 'text' as const, text: 'assignment_id does not belong to this trip.' }], isError: true };

      const { reservation } = updateReservation(reservationId, tripId, {
        title, type, reservation_time, location, confirmation_number, notes, status,
        place_id: place_id !== undefined ? place_id ?? undefined : undefined,
        assignment_id: assignment_id !== undefined ? assignment_id ?? undefined : undefined,
      }, existing);
      broadcast(tripId, 'reservation:updated', { reservation });
      return ok({ reservation });
    }
  );

  // --- BUDGET (update) ---

  server.registerTool(
    'update_budget_item',
    {
      description: 'Update an existing budget/expense item in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
        total_price: z.number().nonnegative().optional(),
        persons: z.number().int().positive().nullable().optional(),
        days: z.number().int().positive().nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      },
    },
    async ({ tripId, itemId, name, category, total_price, persons, days, note }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updateBudgetItem(itemId, tripId, { name, category, total_price, persons, days, note });
      if (!item) return { content: [{ type: 'text' as const, text: 'Budget item not found.' }], isError: true };
      broadcast(tripId, 'budget:updated', { item });
      return ok({ item });
    }
  );

  // --- PACKING (update) ---

  server.registerTool(
    'update_packing_item',
    {
      description: 'Rename a packing item or change its category.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
      },
    },
    async ({ tripId, itemId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bodyKeys = ['name', 'category'].filter(k => k === 'name' ? name !== undefined : category !== undefined);
      const item = updatePackingItem(tripId, itemId, { name, category }, bodyKeys);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      broadcast(tripId, 'packing:updated', { item });
      return ok({ item });
    }
  );

  // --- REORDER ---

  server.registerTool(
    'reorder_day_assignments',
    {
      description: 'Reorder places within a day by providing the assignment IDs in the desired order.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        assignmentIds: z.array(z.number().int().positive()).min(1).max(200).describe('Assignment IDs in desired display order'),
      },
    },
    async ({ tripId, dayId, assignmentIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!getDay(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      reorderAssignments(dayId, assignmentIds);
      broadcast(tripId, 'assignment:reordered', { dayId, assignmentIds });
      return ok({ success: true, dayId, order: assignmentIds });
    }
  );

  // --- TRIP SUMMARY ---

  server.registerTool(
    'get_trip_summary',
    {
      description: 'Get a full denormalized summary of a trip in a single call: metadata, members, days with assignments and notes, accommodations, budget totals, packing stats, reservations, and collab notes. Use this as a context loader before planning or modifying a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const summary = getTripSummary(tripId);
      if (!summary) return noAccess();
      return ok(summary);
    }
  );

  // --- BUCKET LIST ---

  server.registerTool(
    'create_bucket_list_item',
    {
      description: 'Add a destination to your personal travel bucket list.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Destination or experience name'),
        lat: z.number().optional(),
        lng: z.number().optional(),
        country_code: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2 country code'),
        notes: z.string().max(1000).optional(),
      },
    },
    async ({ name, lat, lng, country_code, notes }) => {
      if (isDemoUser(userId)) return demoDenied();
      const item = createBucketItem(userId, { name, lat, lng, country_code, notes });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_bucket_list_item',
    {
      description: 'Remove an item from your travel bucket list.',
      inputSchema: {
        itemId: z.number().int().positive(),
      },
    },
    async ({ itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const deleted = deleteBucketItem(userId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Bucket list item not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  // --- ATLAS ---

  server.registerTool(
    'mark_country_visited',
    {
      description: 'Mark a country as visited in your Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code (e.g. "FR", "JP")'),
      },
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      markCountryVisited(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  server.registerTool(
    'unmark_country_visited',
    {
      description: 'Remove a country from your visited countries in Atlas.',
      inputSchema: {
        country_code: z.string().length(2).toUpperCase().describe('ISO 3166-1 alpha-2 country code'),
      },
    },
    async ({ country_code }) => {
      if (isDemoUser(userId)) return demoDenied();
      unmarkCountryVisited(userId, country_code.toUpperCase());
      return ok({ success: true, country_code: country_code.toUpperCase() });
    }
  );

  // --- COLLAB NOTES ---

  server.registerTool(
    'create_collab_note',
    {
      description: 'Create a shared collaborative note on a trip (visible to all trip members in the Collab tab).',
      inputSchema: {
        tripId: z.number().int().positive(),
        title: z.string().min(1).max(200),
        content: z.string().max(10000).optional(),
        category: z.string().max(100).optional().describe('Note category (e.g. "Ideas", "To-do", "General")'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color for the note card'),
      },
    },
    async ({ tripId, title, content, category, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = createCollabNote(tripId, userId, { title, content, category, color });
      broadcast(tripId, 'collab:note:created', { note });
      return ok({ note });
    }
  );

  server.registerTool(
    'update_collab_note',
    {
      description: 'Edit an existing collaborative note on a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        noteId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().max(10000).optional(),
        category: z.string().max(100).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color for the note card'),
        pinned: z.boolean().optional().describe('Pin the note to the top'),
      },
    },
    async ({ tripId, noteId, title, content, category, color, pinned }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = updateCollabNote(tripId, noteId, { title, content, category, color, pinned });
      if (!note) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      broadcast(tripId, 'collab:note:updated', { note });
      return ok({ note });
    }
  );

  server.registerTool(
    'delete_collab_note',
    {
      description: 'Delete a collaborative note from a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        noteId: z.number().int().positive(),
      },
    },
    async ({ tripId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deleteCollabNote(tripId, noteId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      broadcast(tripId, 'collab:note:deleted', { noteId });
      return ok({ success: true });
    }
  );

  // --- DAY NOTES ---

  server.registerTool(
    'create_day_note',
    {
      description: 'Add a note to a specific day in a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        text: z.string().min(1).max(500),
        time: z.string().max(150).optional().describe('Time label (e.g. "09:00" or "Morning")'),
        icon: z.string().optional().describe('Emoji icon for the note'),
      },
    },
    async ({ tripId, dayId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      if (!dayNoteExists(dayId, tripId)) return { content: [{ type: 'text' as const, text: 'Day not found.' }], isError: true };
      const note = createDayNote(dayId, tripId, text, time, icon);
      broadcast(tripId, 'dayNote:created', { dayId, note });
      return ok({ note });
    }
  );

  server.registerTool(
    'update_day_note',
    {
      description: 'Edit an existing note on a specific day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        noteId: z.number().int().positive(),
        text: z.string().min(1).max(500).optional(),
        time: z.string().max(150).nullable().optional().describe('Time label (e.g. "09:00" or "Morning"), or null to clear'),
        icon: z.string().optional().describe('Emoji icon for the note'),
      },
    },
    async ({ tripId, dayId, noteId, text, time, icon }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const existing = getDayNote(noteId, dayId, tripId);
      if (!existing) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      const note = updateDayNote(noteId, existing, { text, time: time !== undefined ? time : undefined, icon });
      broadcast(tripId, 'dayNote:updated', { dayId, note });
      return ok({ note });
    }
  );

  server.registerTool(
    'delete_day_note',
    {
      description: 'Delete a note from a specific day.',
      inputSchema: {
        tripId: z.number().int().positive(),
        dayId: z.number().int().positive(),
        noteId: z.number().int().positive(),
      },
    },
    async ({ tripId, dayId, noteId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const note = getDayNote(noteId, dayId, tripId);
      if (!note) return { content: [{ type: 'text' as const, text: 'Note not found.' }], isError: true };
      deleteDayNote(noteId);
      broadcast(tripId, 'dayNote:deleted', { noteId, dayId });
      return ok({ success: true });
    }
  );

  // --- TODOS ---

  server.registerTool(
    'list_todos',
    {
      description: 'List all todo items for a trip, ordered by sort order.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const items = listTodoItems(tripId);
      return ok({ items });
    }
  );

  server.registerTool(
    'create_todo',
    {
      description: 'Create a todo item on a trip. Priority is 0 (normal), 1 (high), or 2 (urgent).',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date (YYYY-MM-DD)'),
        description: z.string().max(2000).optional(),
        assigned_user_id: z.number().int().positive().optional().describe('Trip member user_id to assign'),
        priority: z.number().int().min(0).max(2).optional(),
      },
    },
    async ({ tripId, name, category, due_date, description, assigned_user_id, priority }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = createTodoItem(tripId, { name, category, due_date, description, assigned_user_id, priority });
      broadcast(tripId, 'todo:created', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'update_todo',
    {
      description: 'Update a todo item. Pass only the fields you want to change. Use null on nullable fields (due_date, description, assigned_user_id) to clear them.',
      inputSchema: {
        tripId: z.number().int().positive(),
        todoId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        checked: z.boolean().optional(),
        category: z.string().max(100).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        assigned_user_id: z.number().int().positive().nullable().optional(),
        priority: z.number().int().min(0).max(2).nullable().optional(),
      },
    },
    async (args) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(args.tripId, userId)) return noAccess();
      const { tripId, todoId, checked, ...rest } = args;
      const bodyKeys = Object.keys(args).filter(k => k !== 'tripId' && k !== 'todoId');
      const data = {
        ...rest,
        ...(checked !== undefined ? { checked: checked ? 1 : 0 } : {}),
      };
      const item = updateTodoItem(tripId, todoId, data, bodyKeys);
      if (!item) return { content: [{ type: 'text' as const, text: 'Todo not found.' }], isError: true };
      broadcast(tripId, 'todo:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'toggle_todo',
    {
      description: 'Check or uncheck a todo item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        todoId: z.number().int().positive(),
        checked: z.boolean(),
      },
    },
    async ({ tripId, todoId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = updateTodoItem(tripId, todoId, { checked: checked ? 1 : 0 }, ['checked']);
      if (!item) return { content: [{ type: 'text' as const, text: 'Todo not found.' }], isError: true };
      broadcast(tripId, 'todo:updated', { item });
      return ok({ item });
    }
  );

  server.registerTool(
    'delete_todo',
    {
      description: 'Delete a todo item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        todoId: z.number().int().positive(),
      },
    },
    async ({ tripId, todoId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const ok_ = deleteTodoItem(tripId, todoId);
      if (!ok_) return { content: [{ type: 'text' as const, text: 'Todo not found.' }], isError: true };
      broadcast(tripId, 'todo:deleted', { itemId: todoId });
      return ok({ success: true });
    }
  );

  // --- WEATHER ---

  server.registerTool(
    'get_weather',
    {
      description: 'Get a weather summary (daily high/low, conditions) for coordinates. Omit date for current conditions; pass YYYY-MM-DD for a forecast up to 16 days out or a historical climatology estimate beyond that.',
      inputSchema: {
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    async ({ lat, lng, date }) => {
      try {
        const result = await getWeather(String(lat), String(lng), date, 'en');
        return ok(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Weather lookup failed';
        return { content: [{ type: 'text' as const, text: `Weather error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'get_detailed_weather',
    {
      description: 'Get a detailed hourly weather forecast for coordinates on a given date, including hourly temps, precipitation, wind, humidity, and sunrise/sunset.',
      inputSchema: {
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
    async ({ lat, lng, date }) => {
      try {
        const result = await getDetailedWeather(String(lat), String(lng), date, 'en');
        return ok(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Weather lookup failed';
        return { content: [{ type: 'text' as const, text: `Weather error: ${msg}` }], isError: true };
      }
    }
  );

  // --- NOTIFICATIONS (scoped to authenticated user) ---

  server.registerTool(
    'list_notifications',
    {
      description: 'List in-app notifications for the current user. i18n keys (title_key, text_key) and JSON params describe the message.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
        unreadOnly: z.boolean().optional(),
      },
    },
    async ({ limit, offset, unreadOnly }) => {
      const result = getNotifications(userId, { limit, offset, unreadOnly });
      return ok(result);
    }
  );

  server.registerTool(
    'get_unread_notification_count',
    {
      description: 'Get the number of unread in-app notifications for the current user.',
      inputSchema: {},
    },
    async () => {
      return ok({ unread_count: getUnreadCount(userId) });
    }
  );

  server.registerTool(
    'mark_notification_read',
    {
      description: 'Mark a single in-app notification as read.',
      inputSchema: {
        notificationId: z.number().int().positive(),
      },
    },
    async ({ notificationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const changed = markNotificationRead(notificationId, userId);
      if (!changed) return { content: [{ type: 'text' as const, text: 'Notification not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  server.registerTool(
    'mark_all_notifications_read',
    {
      description: 'Mark all in-app notifications for the current user as read. Returns the number of notifications affected.',
      inputSchema: {},
    },
    async () => {
      if (isDemoUser(userId)) return demoDenied();
      const count = markAllNotificationsRead(userId);
      return ok({ marked_read: count });
    }
  );

  server.registerTool(
    'delete_notification',
    {
      description: 'Delete an in-app notification for the current user.',
      inputSchema: {
        notificationId: z.number().int().positive(),
      },
    },
    async ({ notificationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const changed = deleteNotification(notificationId, userId);
      if (!changed) return { content: [{ type: 'text' as const, text: 'Notification not found.' }], isError: true };
      return ok({ success: true });
    }
  );

  server.registerTool(
    'respond_to_notification',
    {
      description: 'Respond to a boolean-type notification (e.g. accept/decline an invite). Only works for notifications with type=boolean that have not already been responded to.',
      inputSchema: {
        notificationId: z.number().int().positive(),
        response: z.enum(['positive', 'negative']),
      },
    },
    async ({ notificationId, response }) => {
      if (isDemoUser(userId)) return demoDenied();
      const result = await respondToNotification(notificationId, userId, response);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: result.error || 'Failed to respond.' }], isError: true };
      }
      return ok({ notification: result.notification });
    }
  );

  // --- RESERVATION FILE LINKS ---
  // Note: uploading files over MCP is not supported (multipart). Use the web UI
  // to upload, then use these tools to list/link/unlink files on reservations.

  server.registerTool(
    'list_reservation_files',
    {
      description: 'List all files linked to a specific reservation, including their download URLs and link IDs (needed for unlinking).',
      inputSchema: {
        tripId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
      },
    },
    async ({ tripId, reservationId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const reservation = getReservation(reservationId, tripId);
      if (!reservation) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      const allFiles = listFiles(tripId, false);
      const files = allFiles
        .filter((f: any) => (f.linked_reservation_ids || []).includes(reservationId) || f.reservation_id === reservationId)
        .map((f: any) => {
          const links = getFileLinks(f.id) as Array<{ id: number; file_id: number; reservation_id: number | null }>;
          const link = links.find(l => l.reservation_id === reservationId);
          return { ...f, link_id: link?.id ?? null };
        });
      return ok({ files });
    }
  );

  server.registerTool(
    'link_file_to_reservation',
    {
      description: 'Link an existing (already-uploaded) file to a reservation. Both the file and the reservation must belong to a trip the user can access.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        reservationId: z.number().int().positive(),
      },
    },
    async ({ tripId, fileId, reservationId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found in this trip.' }], isError: true };
      const reservation = getReservation(reservationId, tripId);
      if (!reservation) return { content: [{ type: 'text' as const, text: 'Reservation not found.' }], isError: true };
      const links = createFileLink(fileId, { reservation_id: String(reservationId) });
      broadcast(tripId, 'file:updated', { fileId });
      return ok({ links });
    }
  );

  server.registerTool(
    'unlink_file_from_reservation',
    {
      description: 'Remove a file-to-reservation link by its link ID (obtainable from list_reservation_files). Does not delete the file itself.',
      inputSchema: {
        tripId: z.number().int().positive(),
        fileId: z.number().int().positive(),
        linkId: z.number().int().positive(),
      },
    },
    async ({ tripId, fileId, linkId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const file = getFileById(fileId, tripId);
      if (!file) return { content: [{ type: 'text' as const, text: 'File not found in this trip.' }], isError: true };
      deleteFileLink(linkId, fileId);
      broadcast(tripId, 'file:updated', { fileId });
      return ok({ success: true });
    }
  );
}
