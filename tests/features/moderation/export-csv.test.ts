/**
 * Normalized audit CSV export: buildExportCsv must shape the model's raw
 * reply into atomic, filterable columns (flag / llm_reason / fun_response /
 * parse_status) while keeping the lossless raw reply as the last column.
 */

import { describe, expect, it } from 'vitest';
import {
  buildExportCsv,
  EXPORT_CSV_HEADER,
} from '../../../src/features/moderation/admin';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: '2026-09-19T10:00:00.000Z',
    level: 'info',
    event: 'safe',
    provider: 'prov',
    model: 'model-x',
    chat_id: -100123,
    chat_username: 'group',
    chat_title: null,
    user_id: 42,
    username: 'alice',
    full_name: null,
    decision: 'keep',
    reason: 'ok',
    message_text: 'hello',
    llm_response: '{"flag":false,"reason":"ok"}',
    ...overrides,
  };
}

describe('buildExportCsv', () => {
  it('emits a UTF-8 BOM and the documented header', () => {
    const csv = buildExportCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(EXPORT_CSV_HEADER.join(','));
    expect(EXPORT_CSV_HEADER).toContain('parse_status');
    expect(EXPORT_CSV_HEADER[EXPORT_CSV_HEADER.length - 1]).toBe(
      'llm_response_raw',
    );
  });

  it('parses a strict JSON reply into atomic columns', () => {
    const line = buildExportCsv([
      row({
        event: 'flagged_deleted',
        level: 'warn',
        decision: 'delete',
        reason: 'spam link',
        llm_response:
          '{"flag":true,"reason":"spam link","fun_response":"nice try"}',
      }),
    ]).split('\n')[1];
    // The raw reply cell is itself CSV-escaped (quotes doubled) like any
    // other quoted field.
    expect(line).toBe(
      '2026-09-19T10:00:00.000Z,warn,flagged_deleted,prov,model-x,' +
        '-100123,group,,42,alice,,delete,spam link,' +
        'true,spam link,nice try,json,hello,' +
        '"{""flag"":true,""reason"":""spam link"",""fun_response"":""nice try""}"',
    );
  });

  it('parses JSON embedded in prose as json_in_prose', () => {
    const line = buildExportCsv([
      row({
        llm_response:
          'Sure! {"flag":false,"reason":"fine"} hope that helps',
      }),
    ]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[16]).toBe('json_in_prose');
    expect(cells[13]).toBe('false');
    expect(cells[14]).toBe('fine');
  });

  it('marks plain flag lines: flag=true with no synthetic reason', () => {
    const line = buildExportCsv([row({ llm_response: 'yes' })]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[16]).toBe('plain');
    expect(cells[13]).toBe('true');
    expect(cells[14]).toBe('');
  });

  it('marks an empty reply as empty with blank flag/reason', () => {
    const line = buildExportCsv([row({ llm_response: '' })]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[16]).toBe('empty');
    expect(cells[13]).toBe('');
    expect(cells[14]).toBe('');
  });

  it('leaves parse_status blank when the event never carried a reply', () => {
    const line = buildExportCsv([
      row({ event: 'moderation_error', llm_response: null }),
    ]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[16]).toBe('');
    expect(cells[13]).toBe('');
    expect(cells[18]).toBe('');
  });

  it('CSV-escapes quotes, commas, and newlines in parsed fields', () => {
    const csv = buildExportCsv([
      row({
        llm_response:
          '{"flag":true,"reason":"bad, link","fun_response":"line1\\nline2, \\"quoted\\""}',
      }),
    ]);
    // Cannot split on '\n' naively: the quoted fun_response cell embeds a
    // real newline, so assert on the whole CSV.
    expect(csv).toContain('"bad, link"');
    expect(csv).toContain('"line1\nline2, ""quoted"""');
  });

  it('renders null optional fields as empty cells', () => {
    const line = buildExportCsv([row({ full_name: null, username: null })])
      .split('\n')[1];
    const cells = line.split(',');
    expect(cells[9]).toBe('');
    expect(cells[10]).toBe('');
  });
});
