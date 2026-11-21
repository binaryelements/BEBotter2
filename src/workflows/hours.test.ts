import { describe, expect, it } from 'vitest'
import { waitUntil } from './hours.js'

const tz = 'Australia/Melbourne'
// Melbourne is UTC+11 in November (daylight saving).
const mel = (iso: string) => new Date(`${iso}+11:00`)

describe('waitUntil', () => {
  it('adds plain minutes without business hours', () => {
    const s = mel('2026-11-18T10:00:00')
    expect(waitUntil(s, 60, false, tz, []).getTime()).toBe(s.getTime() + 3600_000)
  })
  it('rolls Friday 16:30 + 60 to Monday 09:30', () => {
    expect(waitUntil(mel('2026-11-20T16:30:00'), 60, true, tz, []).toISOString()).toBe(mel('2026-11-23T09:30:00').toISOString())
  })
  it('counts a Saturday start from Monday opening', () => {
    expect(waitUntil(mel('2026-11-21T10:00:00'), 1, true, tz, []).toISOString()).toBe(mel('2026-11-23T09:01:00').toISOString())
  })
  it('skips a holiday Monday', () => {
    expect(waitUntil(mel('2026-11-20T16:30:00'), 60, true, tz, ['2026-11-23']).toISOString()).toBe(mel('2026-11-24T09:30:00').toISOString())
  })
  it('480 minutes from Wednesday 10:00 is Thursday 10:00', () => {
    expect(waitUntil(mel('2026-11-18T10:00:00'), 480, true, tz, []).toISOString()).toBe(mel('2026-11-19T10:00:00').toISOString())
  })
  it('follows local time across the April daylight-saving end', () => {
    // DST ends Sun 2026-04-05, so Monday 09:30 local is +10:00.
    expect(waitUntil(new Date('2026-04-03T16:30:00+11:00'), 60, true, tz, []).toISOString()).toBe(new Date('2026-04-06T09:30:00+10:00').toISOString())
  })
})
