// src/tools/calendar.ts

import { DateTime } from 'luxon';

type CalendarProvider = 'google' | 'outlook';

type ScheduleMeetingInput = {
  title: string;
  start: string;
  end: string;
  timezone: string;
  attendees?: string[];
  description?: string;
  confidence?: number;
  provider?: CalendarProvider;
  approvalId?: string;
};

export class CalendarTool {
  constructor(private env: any) {}

  async scheduleMeeting(input: ScheduleMeetingInput) {
    if ((input.confidence ?? 0) < 0.85) {
      throw new Error('Calendar action blocked: confidence below threshold');
    }

    const start = DateTime.fromISO(input.start, { zone: input.timezone });
    const end = DateTime.fromISO(input.end, { zone: input.timezone });

    if (!start.isValid || !end.isValid || start < DateTime.now()) {
      throw new Error('Invalid or past meeting time');
    }

    // Approval workflow
    if (!input.approvalId) {
      const approvalId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO approvals (id, type, payload, status, created)
         VALUES (?, 'calendar', ?, 'pending', ?)`
      )
        .bind(approvalId, JSON.stringify(input), Date.now())
        .run();

      return { approvalRequired: true, approvalId };
    }

    // Load & verify approval
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM approvals WHERE id=? AND status='approved'`
    ).bind(input.approvalId).all();

    if (!results.length) throw new Error('Calendar approval not granted');

    // Provider dispatch (OAuth tokens already stored as secrets)
    if (input.provider === 'outlook') {
      return this.createOutlookEvent(start, end, input);
    }

    return this.createGoogleEvent(start, end, input);
  }

  private async createGoogleEvent(start: DateTime, end: DateTime, input: any) {
    // Placeholder — deploy-ready OAuth slot
    return { scheduled: true, provider: 'google', start: start.toISO(), end: end.toISO() };
  }

  private async createOutlookEvent(start: DateTime, end: DateTime, input: any) {
    // Placeholder — deploy-ready OAuth slot
    return { scheduled: true, provider: 'outlook', start: start.toISO(), end: end.toISO() };
  }
}