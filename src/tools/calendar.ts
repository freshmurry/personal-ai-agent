// src/tools/calendar.ts
import type { Bindings } from '../bindings'

interface MeetingInput {
  title: string
  start: string
  end: string
  timezone: string
  attendees?: string[]
  description?: string
  provider?: 'google' | 'outlook'
}

export class CalendarTool {
  constructor(private _env: Bindings) {}

  async scheduleMeeting(input: MeetingInput): Promise<{ scheduled: boolean; provider: string; title: string; start: string; end: string; attendees: string[]; } | { approvalRequired: boolean; approvalId: string }> {
    // Require human approval for calendar events
    const approvalId = crypto.randomUUID()
    await this._env.DB.prepare(
      `INSERT INTO approvals (id, action, payload, status, created) VALUES (?, 'schedule_meeting', ?, 'pending', ?)`
    )
      .bind(approvalId, JSON.stringify(input), Date.now())
      .run()

    return { approvalRequired: true, approvalId }
  }
}
