import { describe, it, expect, vi } from 'vitest';
import { uploadAttachments } from '../../bitrix/AttachmentUploader.js';

// Mock logger to suppress output during tests
vi.mock('../../logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function createMockClient(callFn) {
  return { call: callFn || vi.fn().mockResolvedValue(123) };
}

describe('AttachmentUploader', () => {
  it('should return zeros when attachments array is empty (Req 11.2)', async () => {
    const client = createMockClient();
    const result = await uploadAttachments(client, 1, []);

    expect(result.uploaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('should return zeros when attachments is null (Req 11.2)', async () => {
    const client = createMockClient();
    const result = await uploadAttachments(client, 1, null);

    expect(result.uploaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('should upload a valid attachment as timeline comment (Req 11.1)', async () => {
    const client = createMockClient(vi.fn().mockResolvedValue(456));
    const attachments = [
      { fileName: 'doc.pdf', fileData: Buffer.from('hello').toString('base64') },
    ];

    const result = await uploadAttachments(client, 10, attachments);

    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details[0]).toEqual({
      fileName: 'doc.pdf',
      commentId: 456,
      success: true,
    });
    expect(client.call).toHaveBeenCalledWith('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: 10,
        ENTITY_TYPE: 'deal',
        COMMENT: 'Anexo: doc.pdf',
        FILES: {
          fileData: ['doc.pdf', attachments[0].fileData],
        },
      },
    });
  });

  it('should skip attachments larger than 20MB (Req 11.4)', async () => {
    const client = createMockClient();
    // Create a base64 string that decodes to > 20MB
    const largeData = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    const attachments = [{ fileName: 'huge.zip', fileData: largeData }];

    const result = await uploadAttachments(client, 1, attachments);

    expect(result.uploaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.details[0].reason).toBe('too_large');
    expect(client.call).not.toHaveBeenCalled();
  });

  it('should continue uploading remaining attachments on individual failure (Req 11.3)', async () => {
    const callFn = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(789);

    const client = createMockClient(callFn);
    const attachments = [
      { fileName: 'fail.pdf', fileData: Buffer.from('data1').toString('base64') },
      { fileName: 'ok.pdf', fileData: Buffer.from('data2').toString('base64') },
    ];

    const result = await uploadAttachments(client, 5, attachments);

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.details[0]).toMatchObject({ fileName: 'fail.pdf', success: false, error: 'network error' });
    expect(result.details[1]).toMatchObject({ fileName: 'ok.pdf', success: true, commentId: 789 });
  });

  it('should skip attachments with no fileData', async () => {
    const client = createMockClient();
    const attachments = [
      { fileName: 'empty.txt', fileData: null },
      { fileName: 'missing.txt' },
    ];

    const result = await uploadAttachments(client, 1, attachments);

    expect(result.skipped).toBe(2);
    expect(result.uploaded).toBe(0);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('should handle mixed results (upload, skip, fail)', async () => {
    const callFn = vi.fn()
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(new Error('timeout'));

    const client = createMockClient(callFn);
    const largeData = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    const attachments = [
      { fileName: 'good.pdf', fileData: Buffer.from('ok').toString('base64') },
      { fileName: 'huge.zip', fileData: largeData },
      { fileName: 'broken.doc', fileData: Buffer.from('x').toString('base64') },
    ];

    const result = await uploadAttachments(client, 7, attachments);

    expect(result.uploaded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details).toHaveLength(3);
  });
});
