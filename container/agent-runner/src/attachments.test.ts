import { describe, expect, it } from 'bun:test';

import { collectQueryAttachments, extractExplicitPaths, type AttachmentLogEvent, type InspectedFile } from './attachments.js';
import type { MessageInRow } from './db/messages-in.js';

function msg(
  id: string,
  content: object,
  opts: Partial<Pick<MessageInRow, 'kind' | 'trigger'>> = {},
): MessageInRow {
  return {
    id,
    seq: 1,
    kind: opts.kind ?? 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: opts.trigger ?? 1,
    platform_id: 'chan',
    channel_type: 'discord',
    thread_id: null,
    content: JSON.stringify(content),
  };
}

function inspector(files: Record<string, Partial<InspectedFile>>) {
  return async (filePath: string): Promise<InspectedFile | null> => {
    const found = files[filePath];
    if (!found) return null;
    return {
      path: filePath,
      realPath: found.realPath ?? filePath,
      filename: found.filename ?? filePath.split('/').at(-1) ?? 'file',
      mime: found.mime ?? 'image/png',
      sizeBytes: found.sizeBytes ?? 12,
      isRegularFile: found.isRegularFile ?? true,
      isSymlink: found.isSymlink ?? false,
    };
  };
}

describe('extractExplicitPaths', () => {
  it('parses quoted, backticked, attach-prefixed, and conservative bare paths', () => {
    expect(
      extractExplicitPaths(
        [
          'look at `/workspace/agent/tmp/Screenshot 2026-05-24 at 11.40.03 AM.png`',
          'and "/workspace/agent/tmp/chart (1)#final.png"',
          'attach: /workspace/agent/tmp/generated-chart.jpg',
          'bare /workspace/outbox/simple.webp.',
        ].join('\n'),
      ),
    ).toEqual([
      '/workspace/agent/tmp/Screenshot 2026-05-24 at 11.40.03 AM.png',
      '/workspace/agent/tmp/chart (1)#final.png',
      '/workspace/agent/tmp/generated-chart.jpg',
      '/workspace/outbox/simple.webp',
    ]);
  });

  it('does not parse host-generated fallback Path lines', () => {
    expect(extractExplicitPaths('Path: /workspace/agent/tmp/generated-by-host.png')).toEqual([]);
  });
});

describe('collectQueryAttachments', () => {
  it('collects materialized inbound attachments before explicit paths', async () => {
    const inboundPath = '/workspace/agent/attachments/discord/m1/photo.png';
    const explicitPath = '/workspace/agent/tmp/chart.png';
    const attachments = await collectQueryAttachments({
      messages: [
        msg('m1', {
          text: 'See attached',
          attachments: [{ workspacePath: inboundPath, originalName: 'photo.png', contentType: 'image/png', sizeBytes: 12 }],
        }),
      ],
      pathReferenceMessages: [msg('m2', { text: `Use ${explicitPath}` })],
      inspectFile: inspector({
        [inboundPath]: { sizeBytes: 12, mime: 'image/png' },
        [explicitPath]: { sizeBytes: 13, mime: 'image/png' },
      }),
    });

    expect(attachments.map((a) => a.path)).toEqual([inboundPath, explicitPath]);
    expect(attachments[0]).toMatchObject({ filename: 'photo.png', mime: 'image/png', sizeBytes: 12 });
  });

  it('rejects explicit mentions of durable attachment history while accepting current-row inbound metadata', async () => {
    const inboundPath = '/workspace/agent/attachments/discord/m1/photo.png';
    const attachments = await collectQueryAttachments({
      messages: [msg('m1', { attachments: [{ workspacePath: inboundPath, contentType: 'image/png', sizeBytes: 12 }] })],
      pathReferenceMessages: [msg('m2', { text: `Use ${inboundPath}` })],
      inspectFile: inspector({ [inboundPath]: { sizeBytes: 12, mime: 'image/png' } }),
    });

    expect(attachments.map((a) => a.path)).toEqual([inboundPath]);
  });

  it('ignores trigger=0 accumulated context and non-chat rows for explicit paths', async () => {
    const filePath = '/workspace/agent/tmp/chart.png';
    const attachments = await collectQueryAttachments({
      messages: [],
      pathReferenceMessages: [
        msg('ctx', { text: filePath }, { trigger: 0 }),
        msg('task', { text: filePath }, { kind: 'task' }),
      ],
      inspectFile: inspector({ [filePath]: { sizeBytes: 12, mime: 'image/png' } }),
    });
    expect(attachments).toEqual([]);
  });

  it('leaves agent-to-agent localPath attachments as text fallback only', async () => {
    const attachments = await collectQueryAttachments({
      messages: [msg('a2a', { attachments: [{ localPath: 'inbox/msg/file.png', name: 'file.png', type: 'image/png' }] })],
      pathReferenceMessages: [],
      inspectFile: inspector({}),
    });
    expect(attachments).toEqual([]);
  });

  it('rejects outside roots, denied paths, symlinks, directories, zero-byte files, and MIME mismatches', async () => {
    const logs: AttachmentLogEvent[] = [];
    const paths = [
      '/workspace/repos/project/image.png',
      '/workspace/agent/browser-auth/state.png',
      '/workspace/agent/tmp/link.png',
      '/workspace/agent/tmp/dir.png',
      '/workspace/agent/tmp/empty.png',
      '/workspace/agent/tmp/mismatch.jpg',
      '/workspace/agent/tmp/file.pdf',
    ];
    const attachments = await collectQueryAttachments({
      messages: [],
      pathReferenceMessages: [msg('m1', { text: paths.map((p) => `\`${p}\``).join(' ') })],
      inspectFile: inspector({
        '/workspace/agent/tmp/link.png': { isSymlink: true, isRegularFile: false },
        '/workspace/agent/tmp/dir.png': { isRegularFile: false },
        '/workspace/agent/tmp/empty.png': { sizeBytes: 0 },
        '/workspace/agent/tmp/mismatch.jpg': { mime: 'image/png', sizeBytes: 10 },
        '/workspace/agent/tmp/file.pdf': { mime: 'application/pdf', sizeBytes: 10 },
      }),
      log: (event) => logs.push(event),
    });

    expect(attachments).toEqual([]);
    const reasons = logs.map((l) => l.reason);
    expect(reasons).toContain('outside_allowed_roots');
    expect(reasons).toContain('denied_path');
    expect(reasons).toContain('symlink');
    expect(reasons).toContain('not_regular_file');
    expect(reasons).toContain('empty_file');
    expect(reasons).toContain('mime_mismatch');
    expect(reasons).toContain('unsupported_mime');
  });

  it('rejects realpath escapes and size/count caps', async () => {
    const logs: AttachmentLogEvent[] = [];
    const attachments = await collectQueryAttachments({
      messages: [],
      pathReferenceMessages: [
        msg('m1', {
          text: [
            '/workspace/agent/tmp/escape.png',
            '/workspace/agent/tmp/large.png',
            '/workspace/agent/tmp/one.png',
            '/workspace/agent/tmp/two.png',
            '/workspace/agent/tmp/three.png',
          ].join(' '),
        }),
      ],
      maxFileBytes: 20,
      maxTotalBytes: 25,
      maxAttachments: 2,
      inspectFile: inspector({
        '/workspace/agent/tmp/escape.png': { realPath: '/etc/escape.png', sizeBytes: 10, mime: 'image/png' },
        '/workspace/agent/tmp/large.png': { sizeBytes: 21, mime: 'image/png' },
        '/workspace/agent/tmp/one.png': { sizeBytes: 10, mime: 'image/png' },
        '/workspace/agent/tmp/two.png': { sizeBytes: 10, mime: 'image/png' },
        '/workspace/agent/tmp/three.png': { sizeBytes: 10, mime: 'image/png' },
      }),
      log: (event) => logs.push(event),
    });

    expect(attachments.map((a) => a.path)).toEqual(['/workspace/agent/tmp/one.png', '/workspace/agent/tmp/two.png']);
    const reasons = logs.map((l) => l.reason);
    expect(reasons).toContain('realpath_outside_allowed_roots');
    expect(reasons).toContain('file_too_large');
    expect(reasons).toContain('max_attachments');
  });

  it('deduplicates by real path and logs structured accept/skip events without full paths', async () => {
    const logs: AttachmentLogEvent[] = [];
    const first = '/workspace/agent/tmp/first.png';
    const second = '/workspace/outbox/second.png';
    const attachments = await collectQueryAttachments({
      messages: [],
      pathReferenceMessages: [msg('m1', { text: `${first} ${second}` })],
      inspectFile: inspector({
        [first]: { realPath: '/workspace/agent/tmp/shared.png', sizeBytes: 12, mime: 'image/png' },
        [second]: { realPath: '/workspace/agent/tmp/shared.png', sizeBytes: 12, mime: 'image/png' },
      }),
      log: (event) => logs.push(event),
    });

    expect(attachments).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'attachment_accepted', source: 'explicit_path', basename: 'first.png' });
    expect(logs[0]).not.toHaveProperty('path');
    expect(logs[1]).toMatchObject({ event: 'attachment_skipped', reason: 'duplicate' });
  });
});
